import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/core/ui_presentation.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

const int meetingCandidatePageSize = 20;
const int _candidateDebounceMilliseconds = 300;

class MeetingCandidateQuery {
  factory MeetingCandidateQuery({
    required String search,
    int page = 0,
    int size = meetingCandidatePageSize,
  }) {
    final query = search.trim();
    if (query.length < 2 || query.length > 200) {
      throw ArgumentError.value(
        search,
        'search',
        'Must contain 2–200 non-whitespace characters.',
      );
    }
    if (page < 0 || size < 1 || size > meetingCandidatePageSize) {
      throw ArgumentError.value(
        '$page/$size',
        'page',
        'Invalid zero-based candidate page or page size.',
      );
    }
    return MeetingCandidateQuery._(search: query, page: page, size: size);
  }

  const MeetingCandidateQuery._({
    required this.search,
    required this.page,
    required this.size,
  });

  final String search;
  final int page;
  final int size;

  Map<String, String> toQueryParameters() => Map<String, String>.unmodifiable({
    'q': search,
    'page': '$page',
    'size': '$size',
  });
}

class MeetingParticipantCandidate {
  const MeetingParticipantCandidate({
    required this.id,
    required this.displayName,
    required this.email,
    required this.organizationalUnitName,
  });

  final String id;
  final String displayName;
  final String email;
  final String? organizationalUnitName;

  factory MeetingParticipantCandidate.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => MeetingParticipantCandidate(
    id: requiredIdentifier(raw, 'id', response: response),
    displayName: requiredString(
      raw,
      'displayName',
      response: response,
      nonEmpty: true,
    ),
    email: requiredString(raw, 'email', response: response, nonEmpty: true),
    organizationalUnitName: optionalString(
      raw,
      'organizationalUnitName',
      response: response,
    ),
  );
}

class ParticipantCandidateRepository {
  ParticipantCandidateRepository(this.api);

  final ApiClient api;

  Future<PagedCollection<MeetingParticipantCandidate>> search(
    MeetingCandidateQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.get(
      '/users/meeting-candidates',
      query: query.toQueryParameters(),
      sessionScope: sessionScope,
    );
    api.requireCurrentAuthenticatedSession(sessionScope);
    return PagedCollection<MeetingParticipantCandidate>.fromResult(
      response,
      (raw) => MeetingParticipantCandidate.fromJson(raw, response: response),
      requestedPage: query.page,
      requestedSize: query.size,
    );
  }
}

enum ParticipantSelectionMode { single, multiple }

enum CandidateSearchPhase { idle, loading, loaded, loadingMore, failed }

class ParticipantPickerState {
  const ParticipantPickerState({
    required this.searchInput,
    required this.appliedQuery,
    required this.candidates,
    required this.selected,
    required this.phase,
    required this.hasMore,
    required this.collectionChanged,
    required this.failure,
    this.excludedUserIds = const <String>{},
  });

  final String searchInput;
  final MeetingCandidateQuery? appliedQuery;
  final List<MeetingParticipantCandidate> candidates;
  final List<MeetingParticipantCandidate> selected;
  final CandidateSearchPhase phase;
  final bool hasMore;
  final bool collectionChanged;
  final Object? failure;
  final Set<String> excludedUserIds;

  bool get isLoading =>
      phase == CandidateSearchPhase.loading ||
      phase == CandidateSearchPhase.loadingMore;
  bool get isConfirmedEmpty =>
      phase == CandidateSearchPhase.loaded && candidates.isEmpty;

  bool canSelect(MeetingParticipantCandidate candidate) {
    final id = candidate.id.toLowerCase();
    return !excludedUserIds.contains(id);
  }
}

class ParticipantPickerController extends ChangeNotifier {
  ParticipantPickerController({
    required this.repository,
    required this.sessionScope,
    required this.organizerId,
    this.activeParticipantIds = const <String>[],
    this.mode = ParticipantSelectionMode.multiple,
    Iterable<MeetingParticipantCandidate> initialSelection =
        const <MeetingParticipantCandidate>[],
  }) : _state = ParticipantPickerState(
         searchInput: '',
         appliedQuery: null,
         candidates: const <MeetingParticipantCandidate>[],
         selected: List<MeetingParticipantCandidate>.unmodifiable(
           initialSelection,
         ),
         phase: CandidateSearchPhase.idle,
         hasMore: false,
         collectionChanged: false,
         failure: null,
       ) {
    _selectedById.addEntries(
      initialSelection.map(
        (candidate) => MapEntry(candidate.id.toLowerCase(), candidate),
      ),
    );
    _excludedIds = <String>{
      organizerId.toLowerCase(),
      ...activeParticipantIds.map((id) => id.toLowerCase()),
    };
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ParticipantCandidateRepository repository;
  final AuthenticatedSessionScope sessionScope;
  final String organizerId;
  final List<String> activeParticipantIds;
  final ParticipantSelectionMode mode;
  late final Set<String> _excludedIds;
  ParticipantPickerState _state;
  PageWindow<MeetingParticipantCandidate> _window =
      PageWindow<MeetingParticipantCandidate>();
  final Map<String, MeetingParticipantCandidate> _selectedById =
      <String, MeetingParticipantCandidate>{};
  final Map<String, Future<void>> _operations = <String, Future<void>>{};
  Timer? _debounce;
  int _generation = 0;
  int? _expectedTotalElements;
  int? _expectedTotalPages;
  bool _disposed = false;

  ParticipantPickerState get state => ParticipantPickerState(
    searchInput: _state.searchInput,
    appliedQuery: _state.appliedQuery,
    candidates: _state.candidates,
    selected: List<MeetingParticipantCandidate>.unmodifiable(
      _selectedById.values,
    ),
    phase: _state.phase,
    hasMore: _state.hasMore,
    collectionChanged: _state.collectionChanged,
    failure: _state.failure,
    excludedUserIds: Set<String>.unmodifiable(_excludedIds),
  );

  void setSearchInput(String value) {
    if (_disposed) return;
    _debounce?.cancel();
    _state = _copyState(searchInput: value, failure: null);
    final trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 200) {
      _resetQuery();
      _state = _copyState(searchInput: value, phase: CandidateSearchPhase.idle);
      notifyListeners();
      return;
    }
    notifyListeners();
    _debounce = Timer(
      const Duration(milliseconds: _candidateDebounceMilliseconds),
      () => unawaited(_applySearch(trimmed)),
    );
  }

  Future<void> searchNow(String value) {
    _debounce?.cancel();
    if (_disposed) return Future<void>.value();
    _state = _copyState(searchInput: value, failure: null);
    notifyListeners();
    final trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 200) {
      _resetQuery();
      _state = _copyState(searchInput: value, phase: CandidateSearchPhase.idle);
      notifyListeners();
      return Future<void>.value();
    }
    return _applySearch(trimmed, force: true);
  }

  Future<void> _applySearch(String query, {bool force = false}) {
    if (_disposed ||
        !repository.api.isCurrentAuthenticatedSession(sessionScope)) {
      return Future<void>.value();
    }
    if (!force &&
        _state.appliedQuery?.search == query &&
        _state.phase == CandidateSearchPhase.loaded) {
      return Future<void>.value();
    }
    _generation++;
    _window = PageWindow<MeetingParticipantCandidate>();
    _expectedTotalElements = null;
    _expectedTotalPages = null;
    _state = ParticipantPickerState(
      searchInput: _state.searchInput,
      appliedQuery: MeetingCandidateQuery(search: query),
      candidates: const <MeetingParticipantCandidate>[],
      selected: const <MeetingParticipantCandidate>[],
      phase: CandidateSearchPhase.loading,
      hasMore: true,
      collectionChanged: false,
      failure: null,
    );
    notifyListeners();
    return _fetchPage(_generation, loadingMore: false);
  }

  Future<void> loadMore() {
    if (!_state.hasMore ||
        _state.appliedQuery == null ||
        _state.phase == CandidateSearchPhase.loading ||
        _state.phase == CandidateSearchPhase.loadingMore) {
      return Future<void>.value();
    }
    return _fetchPage(_generation, loadingMore: _window.nextPage > 0);
  }

  Future<void> retry() {
    if (_state.appliedQuery == null) {
      return searchNow(_state.searchInput);
    }
    return _fetchPage(_generation, loadingMore: _window.nextPage > 0);
  }

  Future<void> _fetchPage(int generation, {required bool loadingMore}) {
    final query = _state.appliedQuery;
    if (query == null || _disposed) return Future<void>.value();
    final page = _window.nextPage;
    final key = '$generation:$page';
    final existing = _operations[key];
    if (existing != null) return existing;
    final token = _window.beginRequest();
    _state = _copyState(
      phase: loadingMore
          ? CandidateSearchPhase.loadingMore
          : CandidateSearchPhase.loading,
      failure: null,
    );
    notifyListeners();
    late final Future<void> operation;
    operation = _loadPage(query, token, generation).whenComplete(() {
      _operations.remove(key);
    });
    _operations[key] = operation;
    return operation;
  }

  Future<void> _loadPage(
    MeetingCandidateQuery query,
    PageRequestToken token,
    int generation,
  ) async {
    try {
      final page = await repository.search(
        MeetingCandidateQuery(
          search: query.search,
          page: token.page,
          size: query.size,
        ),
        sessionScope: sessionScope,
      );
      if (!_owns(generation, query)) return;
      final totalsChanged =
          (_expectedTotalElements != null &&
              _expectedTotalElements != page.totalElements) ||
          (_expectedTotalPages != null &&
              _expectedTotalPages != page.totalPages);
      _expectedTotalElements ??= page.totalElements;
      _expectedTotalPages ??= page.totalPages;
      final seen = _state.candidates
          .map((candidate) => candidate.id.toLowerCase())
          .toSet();
      final duplicate = page.items.any(
        (candidate) => !seen.add(candidate.id.toLowerCase()),
      );
      _window.accept(page, request: token);
      final candidates = <String, MeetingParticipantCandidate>{
        for (final candidate in _state.candidates)
          candidate.id.toLowerCase(): candidate,
        for (final candidate in page.items)
          candidate.id.toLowerCase(): candidate,
      }.values.toList(growable: false);
      final collectionChanged = totalsChanged || duplicate;
      _state = ParticipantPickerState(
        searchInput: _state.searchInput,
        appliedQuery: query,
        candidates: List<MeetingParticipantCandidate>.unmodifiable(candidates),
        selected: const <MeetingParticipantCandidate>[],
        phase: CandidateSearchPhase.loaded,
        hasMore: _window.hasMore && !collectionChanged,
        collectionChanged: collectionChanged,
        failure: null,
      );
    } catch (error) {
      if (!_owns(generation, query)) return;
      _state = _copyState(phase: CandidateSearchPhase.failed, failure: error);
    } finally {
      if (_owns(generation, query)) notifyListeners();
    }
  }

  void toggleSelection(MeetingParticipantCandidate candidate) {
    if (_disposed || !_isCurrentSession || !canSelect(candidate)) return;
    final key = candidate.id.toLowerCase();
    if (_selectedById.containsKey(key)) {
      _selectedById.remove(key);
    } else if (mode == ParticipantSelectionMode.single) {
      _selectedById
        ..clear()
        ..[key] = candidate;
    } else {
      _selectedById[key] = candidate;
    }
    notifyListeners();
  }

  bool isSelected(MeetingParticipantCandidate candidate) =>
      _selectedById.containsKey(candidate.id.toLowerCase());

  bool canSelect(MeetingParticipantCandidate candidate) =>
      _isCurrentSession &&
      !_excludedIds.contains(candidate.id.toLowerCase()) &&
      (isSelected(candidate) ||
          mode == ParticipantSelectionMode.multiple ||
          _selectedById.isEmpty ||
          isSelected(candidate));

  bool get _isCurrentSession =>
      repository.api.isCurrentAuthenticatedSession(sessionScope);

  ParticipantPickerState _copyState({
    String? searchInput,
    MeetingCandidateQuery? appliedQuery,
    List<MeetingParticipantCandidate>? candidates,
    CandidateSearchPhase? phase,
    bool? hasMore,
    bool? collectionChanged,
    Object? failure,
  }) => ParticipantPickerState(
    searchInput: searchInput ?? _state.searchInput,
    appliedQuery: appliedQuery ?? _state.appliedQuery,
    candidates: candidates ?? _state.candidates,
    selected: const <MeetingParticipantCandidate>[],
    phase: phase ?? _state.phase,
    hasMore: hasMore ?? _state.hasMore,
    collectionChanged: collectionChanged ?? _state.collectionChanged,
    failure: failure,
  );

  void _resetQuery() {
    _generation++;
    _window = PageWindow<MeetingParticipantCandidate>();
    _expectedTotalElements = null;
    _expectedTotalPages = null;
    _state = ParticipantPickerState(
      searchInput: _state.searchInput,
      appliedQuery: null,
      candidates: const <MeetingParticipantCandidate>[],
      selected: const <MeetingParticipantCandidate>[],
      phase: CandidateSearchPhase.idle,
      hasMore: false,
      collectionChanged: false,
      failure: null,
    );
  }

  bool _owns(int generation, MeetingCandidateQuery query) =>
      !_disposed &&
      generation == _generation &&
      _state.appliedQuery?.search == query.search &&
      _isCurrentSession;

  void _sessionChanged() {
    if (_disposed || _isCurrentSession) return;
    _debounce?.cancel();
    _generation++;
    _selectedById.clear();
    _resetQuery();
    _state = ParticipantPickerState(
      searchInput: '',
      appliedQuery: null,
      candidates: const <MeetingParticipantCandidate>[],
      selected: const <MeetingParticipantCandidate>[],
      phase: CandidateSearchPhase.idle,
      hasMore: false,
      collectionChanged: false,
      failure: null,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _debounce?.cancel();
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    _generation++;
    _operations.clear();
    _selectedById.clear();
    super.dispose();
  }
}

Future<List<MeetingParticipantCandidate>?> showParticipantPicker(
  BuildContext context, {
  required ParticipantCandidateRepository repository,
  required AuthenticatedSessionScope sessionScope,
  required String organizerId,
  Iterable<String> activeParticipantIds = const <String>[],
  Iterable<MeetingParticipantCandidate> initialSelection =
      const <MeetingParticipantCandidate>[],
  ParticipantSelectionMode mode = ParticipantSelectionMode.multiple,
  String title = 'Chọn người tham gia',
}) => showDialog<List<MeetingParticipantCandidate>>(
  context: context,
  builder: (_) => ParticipantPickerDialog(
    repository: repository,
    sessionScope: sessionScope,
    organizerId: organizerId,
    activeParticipantIds: activeParticipantIds.toList(),
    initialSelection: initialSelection.toList(),
    mode: mode,
    title: title,
  ),
);

class ParticipantPickerDialog extends StatefulWidget {
  const ParticipantPickerDialog({
    super.key,
    required this.repository,
    required this.sessionScope,
    required this.organizerId,
    required this.activeParticipantIds,
    required this.initialSelection,
    required this.mode,
    required this.title,
  });

  final ParticipantCandidateRepository repository;
  final AuthenticatedSessionScope sessionScope;
  final String organizerId;
  final List<String> activeParticipantIds;
  final List<MeetingParticipantCandidate> initialSelection;
  final ParticipantSelectionMode mode;
  final String title;

  @override
  State<ParticipantPickerDialog> createState() =>
      _ParticipantPickerDialogState();
}

class _ParticipantPickerDialogState extends State<ParticipantPickerDialog> {
  late final ParticipantPickerController _controller;

  @override
  void initState() {
    super.initState();
    _controller = ParticipantPickerController(
      repository: widget.repository,
      sessionScope: widget.sessionScope,
      organizerId: widget.organizerId,
      activeParticipantIds: widget.activeParticipantIds,
      mode: widget.mode,
      initialSelection: widget.initialSelection,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      return AlertDialog(
        title: Text(widget.title),
        content: SizedBox(
          width: 480,
          height: 440,
          child: Column(
            children: [
              TextField(
                autofocus: true,
                onChanged: _controller.setSearchInput,
                textInputAction: TextInputAction.search,
                onSubmitted: (value) => _controller.searchNow(value),
                decoration: const InputDecoration(
                  hintText: 'Tìm tên hoặc email',
                  prefixIcon: Icon(Icons.search),
                ),
              ),
              if (state.isLoading) const LinearProgressIndicator(),
              if (state.collectionChanged)
                const ListTile(
                  leading: Icon(Icons.sync_problem_outlined),
                  title: Text('Danh sách thay đổi trong lúc tải'),
                  subtitle: Text('Hãy tìm lại để xem kết quả mới nhất.'),
                ),
              Expanded(child: _candidateResults(state)),
              if (state.selected.isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text('${state.selected.length} người đã chọn'),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: state.selected.isEmpty
                ? null
                : () => Navigator.pop(context, state.selected),
            child: const Text('Xác nhận'),
          ),
        ],
      );
    },
  );

  Widget _candidateResults(ParticipantPickerState state) {
    if (state.phase == CandidateSearchPhase.idle) {
      return const Center(
        child: Text('Nhập ít nhất 2 ký tự để tìm nhân viên.'),
      );
    }
    if (state.phase == CandidateSearchPhase.failed &&
        state.candidates.isEmpty) {
      return MessagePanel(
        icon: Icons.cloud_off_outlined,
        title: 'Không thể tìm người tham gia',
        description: apiFailureLabel(state.failure),
        onRetry: _controller.retry,
      );
    }
    if (state.isConfirmedEmpty) {
      return const MessagePanel(
        icon: Icons.person_search_outlined,
        title: 'Không tìm thấy nhân viên',
      );
    }
    return ListView.builder(
      itemCount:
          state.candidates.length +
          (state.hasMore || state.phase == CandidateSearchPhase.failed ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == state.candidates.length) {
          return TextButton(
            onPressed: state.phase == CandidateSearchPhase.loadingMore
                ? null
                : state.phase == CandidateSearchPhase.failed
                ? _controller.retry
                : _controller.loadMore,
            child: Text(
              state.phase == CandidateSearchPhase.failed
                  ? 'Thử tải tiếp'
                  : 'Tải thêm',
            ),
          );
        }
        final candidate = state.candidates[index];
        final selected = _controller.isSelected(candidate);
        final enabled = _controller.canSelect(candidate);
        return ListTile(
          enabled: enabled,
          title: Text(candidate.displayName),
          subtitle: Text(
            candidate.organizationalUnitName == null
                ? candidate.email
                : '${candidate.email} · ${candidate.organizationalUnitName}',
          ),
          trailing: widget.mode == ParticipantSelectionMode.multiple
              ? Checkbox(
                  value: selected,
                  onChanged: enabled
                      ? (_) {
                          _controller.toggleSelection(candidate);
                        }
                      : null,
                )
              : selected
              ? const Icon(Icons.check_circle_outline)
              : null,
          onTap: enabled ? () => _controller.toggleSelection(candidate) : null,
        );
      },
    );
  }
}
