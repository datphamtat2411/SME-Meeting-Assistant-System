import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';

class RoomChoice {
  const RoomChoice({
    required this.id,
    required this.code,
    required this.name,
    required this.location,
    required this.capacity,
    required this.available,
    required this.capacityExceeded,
  });

  final String id;
  final String code;
  final String name;
  final String? location;
  final int? capacity;
  final bool? available;
  final bool? capacityExceeded;

  factory RoomChoice.fromCatalog(MeetingRoom room) => RoomChoice(
    id: room.id,
    code: room.code,
    name: room.name,
    location: room.location,
    capacity: room.capacity,
    available: null,
    capacityExceeded: null,
  );

  factory RoomChoice.fromAvailability(AvailableRoom room) => RoomChoice(
    id: room.id,
    code: room.code,
    name: room.name,
    location: room.location,
    capacity: room.capacity,
    available: room.available,
    capacityExceeded: room.capacityExceeded,
  );
}

enum RoomSelectionPhase { idle, loading, loaded, loadingMore, failed }

class RoomSelectionState {
  const RoomSelectionState({
    required this.searchInput,
    required this.appliedSearch,
    required this.rooms,
    required this.phase,
    required this.hasMore,
    required this.collectionChanged,
    required this.failure,
  });

  final String searchInput;
  final String? appliedSearch;
  final List<RoomChoice> rooms;
  final RoomSelectionPhase phase;
  final bool hasMore;
  final bool collectionChanged;
  final Object? failure;
}

class RoomSelectionController extends ChangeNotifier {
  RoomSelectionController({
    required this.repository,
    required this.sessionScope,
    this.interval,
    this.participantCount,
  }) : _state = const RoomSelectionState(
         searchInput: '',
         appliedSearch: null,
         rooms: <RoomChoice>[],
         phase: RoomSelectionPhase.idle,
         hasMore: false,
         collectionChanged: false,
         failure: null,
       ) {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final RoomSchedulingRepository repository;
  final AuthenticatedSessionScope sessionScope;
  MeetingInterval? interval;
  int? participantCount;
  RoomSelectionState _state;
  PageWindow<RoomChoice> _window = PageWindow<RoomChoice>();
  final Map<String, Future<void>> _operations = <String, Future<void>>{};
  int? _totalElements;
  int? _totalPages;
  int _generation = 0;
  bool _disposed = false;

  RoomSelectionState get state => _state;

  Future<void> initialize() => _fetchPage();

  void setSearchInput(String value) {
    if (_disposed) return;
    _state = _copy(searchInput: value);
    notifyListeners();
  }

  Future<void> searchNow([String? value]) {
    if (_disposed) return Future<void>.value();
    _generation++;
    _window = PageWindow<RoomChoice>();
    _totalElements = null;
    _totalPages = null;
    _state = RoomSelectionState(
      searchInput: value ?? _state.searchInput,
      appliedSearch: _normalizeSearch(value ?? _state.searchInput),
      rooms: const <RoomChoice>[],
      phase: RoomSelectionPhase.loading,
      hasMore: true,
      collectionChanged: false,
      failure: null,
    );
    notifyListeners();
    return _fetchPage();
  }

  Future<void> updateAvailability({
    required MeetingInterval? interval,
    required int? participantCount,
  }) {
    if (this.interval?.start == interval?.start &&
        this.interval?.end == interval?.end &&
        this.participantCount == participantCount) {
      return Future<void>.value();
    }
    this.interval = interval;
    this.participantCount = participantCount;
    return searchNow();
  }

  Future<void> loadMore() {
    if (_disposed ||
        !_state.hasMore ||
        _state.phase == RoomSelectionPhase.loading ||
        _state.phase == RoomSelectionPhase.loadingMore ||
        _state.collectionChanged) {
      return Future<void>.value();
    }
    return _fetchPage();
  }

  Future<void> retry() {
    if (_disposed) return Future<void>.value();
    return _fetchPage();
  }

  Future<void> _fetchPage() {
    if (_disposed ||
        !repository.api.isCurrentAuthenticatedSession(sessionScope) ||
        !_window.hasMore) {
      return Future<void>.value();
    }
    final generation = _generation;
    final token = _window.beginRequest();
    final key = '$generation:${token.page}';
    final existing = _operations[key];
    if (existing != null) return existing;
    final loadingMore = token.page > 0;
    _state = _copy(
      phase: loadingMore
          ? RoomSelectionPhase.loadingMore
          : RoomSelectionPhase.loading,
      failure: null,
    );
    notifyListeners();
    late final Future<void> operation;
    operation = _loadPage(token, generation).whenComplete(() {
      _operations.remove(key);
    });
    _operations[key] = operation;
    return operation;
  }

  Future<void> _loadPage(PageRequestToken token, int generation) async {
    try {
      final PagedCollection<RoomChoice> page;
      final query = _state.appliedSearch;
      if (interval case final activeInterval?) {
        final result = await repository.availability(
          RoomAvailabilityQuery(
            interval: activeInterval,
            search: query,
            participantCount: participantCount,
            page: token.page,
            size: roomPageSize,
          ),
          sessionScope: sessionScope,
        );
        page = PagedCollection<RoomChoice>(
          items: result.items.map(RoomChoice.fromAvailability).toList(),
          page: result.page,
          size: result.size,
          totalElements: result.totalElements,
          totalPages: result.totalPages,
          hasNext: result.hasNext,
          hasPrevious: result.hasPrevious,
        );
      } else {
        final result = await repository.catalog(
          RoomCatalogQuery(search: query, page: token.page, size: roomPageSize),
          sessionScope: sessionScope,
        );
        page = PagedCollection<RoomChoice>(
          items: result.items.map(RoomChoice.fromCatalog).toList(),
          page: result.page,
          size: result.size,
          totalElements: result.totalElements,
          totalPages: result.totalPages,
          hasNext: result.hasNext,
          hasPrevious: result.hasPrevious,
        );
      }
      if (!_owns(generation)) return;
      final changed =
          (_totalElements != null && _totalElements != page.totalElements) ||
          (_totalPages != null && _totalPages != page.totalPages);
      _totalElements ??= page.totalElements;
      _totalPages ??= page.totalPages;
      final seen = _state.rooms.map((room) => room.id.toLowerCase()).toSet();
      final duplicate = page.items.any(
        (room) => !seen.add(room.id.toLowerCase()),
      );
      _window.accept(page, request: token);
      final rooms = <String, RoomChoice>{
        for (final room in _state.rooms) room.id.toLowerCase(): room,
        for (final room in page.items) room.id.toLowerCase(): room,
      }.values.toList(growable: false);
      _state = RoomSelectionState(
        searchInput: _state.searchInput,
        appliedSearch: _state.appliedSearch,
        rooms: List<RoomChoice>.unmodifiable(rooms),
        phase: RoomSelectionPhase.loaded,
        hasMore: _window.hasMore && !changed && !duplicate,
        collectionChanged: changed || duplicate,
        failure: null,
      );
    } catch (error) {
      if (!_owns(generation)) return;
      _state = _copy(phase: RoomSelectionPhase.failed, failure: error);
    } finally {
      if (_owns(generation)) notifyListeners();
    }
  }

  RoomSelectionState _copy({
    String? searchInput,
    String? appliedSearch,
    RoomSelectionPhase? phase,
    Object? failure,
  }) => RoomSelectionState(
    searchInput: searchInput ?? _state.searchInput,
    appliedSearch: appliedSearch ?? _state.appliedSearch,
    rooms: _state.rooms,
    phase: phase ?? _state.phase,
    hasMore: _state.hasMore,
    collectionChanged: _state.collectionChanged,
    failure: failure,
  );

  bool _owns(int generation) =>
      !_disposed &&
      generation == _generation &&
      repository.api.isCurrentAuthenticatedSession(sessionScope);

  void _sessionChanged() {
    if (_disposed ||
        repository.api.isCurrentAuthenticatedSession(sessionScope)) {
      return;
    }
    _generation++;
    _window = PageWindow<RoomChoice>();
    _operations.clear();
    _state = const RoomSelectionState(
      searchInput: '',
      appliedSearch: null,
      rooms: <RoomChoice>[],
      phase: RoomSelectionPhase.idle,
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
    _generation++;
    _operations.clear();
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}

class MeetingRoomSelector extends StatelessWidget {
  const MeetingRoomSelector({
    super.key,
    required this.repository,
    required this.sessionScope,
    required this.selectedId,
    required this.interval,
    required this.participantCount,
    required this.onChanged,
    this.label = 'Phòng họp (tùy chọn)',
    this.enabled = true,
  });

  final RoomSchedulingRepository repository;
  final AuthenticatedSessionScope sessionScope;
  final String? selectedId;
  final MeetingInterval? interval;
  final int? participantCount;
  final ValueChanged<String?> onChanged;
  final String label;
  final bool enabled;

  @override
  Widget build(BuildContext context) => OutlinedButton.icon(
    onPressed: !enabled
        ? null
        : () async {
            final roomId = await showDialog<String?>(
              context: context,
              builder: (_) => RoomPickerDialog(
                repository: repository,
                sessionScope: sessionScope,
                interval: interval,
                participantCount: participantCount,
                selectedId: selectedId,
              ),
            );
            if (roomId != null) onChanged(roomId.isEmpty ? null : roomId);
          },
    icon: const Icon(Icons.meeting_room_outlined),
    label: Text(
      selectedId == null ? label : 'Phòng đã chọn',
      overflow: TextOverflow.ellipsis,
    ),
  );
}

class RoomPickerDialog extends StatefulWidget {
  const RoomPickerDialog({
    super.key,
    required this.repository,
    required this.sessionScope,
    required this.interval,
    required this.participantCount,
    required this.selectedId,
  });

  final RoomSchedulingRepository repository;
  final AuthenticatedSessionScope sessionScope;
  final MeetingInterval? interval;
  final int? participantCount;
  final String? selectedId;

  @override
  State<RoomPickerDialog> createState() => _RoomPickerDialogState();
}

class _RoomPickerDialogState extends State<RoomPickerDialog> {
  late final RoomSelectionController _controller;

  @override
  void initState() {
    super.initState();
    _controller = RoomSelectionController(
      repository: widget.repository,
      sessionScope: widget.sessionScope,
      interval: widget.interval,
      participantCount: widget.participantCount,
    );
    unawaited(_controller.initialize());
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
        title: Text(
          widget.interval == null ? 'Chọn phòng họp' : 'Chọn phòng theo lịch',
        ),
        content: SizedBox(
          width: 480,
          height: 440,
          child: Column(
            children: [
              TextField(
                onChanged: _controller.setSearchInput,
                onSubmitted: _controller.searchNow,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Tìm tên, mã hoặc vị trí',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: IconButton(
                    onPressed: () =>
                        _controller.searchNow(_controller.state.searchInput),
                    icon: const Icon(Icons.arrow_forward),
                  ),
                ),
              ),
              if (state.phase == RoomSelectionPhase.loading ||
                  state.phase == RoomSelectionPhase.loadingMore)
                const LinearProgressIndicator(),
              if (state.collectionChanged)
                const ListTile(
                  leading: Icon(Icons.sync_problem_outlined),
                  title: Text('Danh sách phòng đã thay đổi'),
                  subtitle: Text('Tìm lại để làm mới danh sách.'),
                ),
              Expanded(child: _roomResults(state)),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Đóng'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, ''),
            child: const Text('Không chọn phòng'),
          ),
        ],
      );
    },
  );

  Widget _roomResults(RoomSelectionState state) {
    if (state.phase == RoomSelectionPhase.failed && state.rooms.isEmpty) {
      return MessagePanel(
        icon: Icons.cloud_off_outlined,
        title: 'Không thể tải danh sách phòng',
        description: state.failure is ApiFailure
            ? (state.failure! as ApiFailure).message
            : 'Đã xảy ra lỗi khi tải phòng.',
        onRetry: _controller.retry,
      );
    }
    if (state.phase == RoomSelectionPhase.loaded && state.rooms.isEmpty) {
      return const MessagePanel(title: 'Không tìm thấy phòng họp');
    }
    if (state.phase == RoomSelectionPhase.idle) {
      return const Center(child: CircularProgressIndicator());
    }
    return ListView.builder(
      itemCount:
          state.rooms.length +
          (state.hasMore || state.phase == RoomSelectionPhase.failed ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == state.rooms.length) {
          return TextButton(
            onPressed: state.phase == RoomSelectionPhase.failed
                ? _controller.retry
                : _controller.loadMore,
            child: Text(
              state.phase == RoomSelectionPhase.failed
                  ? 'Thử tải tiếp'
                  : 'Tải thêm phòng',
            ),
          );
        }
        final room = state.rooms[index];
        final location = room.location == null ? '' : ' · ${room.location}';
        final availability = room.available == null
            ? ''
            : room.available!
            ? ' · Trống'
            : ' · Bận';
        final capacityWarning = room.capacityExceeded == true
            ? ' · Vượt sức chứa'
            : '';
        return ListTile(
          selected: room.id == widget.selectedId,
          enabled: room.available != false || room.id == widget.selectedId,
          title: Text('${room.name} (${room.code})'),
          subtitle: Text(
            '${room.capacity == null ? 'Sức chứa chưa rõ' : 'Tối đa ${room.capacity} người'}$location$availability$capacityWarning',
            style: TextStyle(
              color: room.capacityExceeded == true ? Palette.amber : null,
            ),
          ),
          trailing: room.id == widget.selectedId
              ? const Icon(Icons.check_circle_outline)
              : null,
          onTap: room.available == false && room.id != widget.selectedId
              ? null
              : () => Navigator.pop(context, room.id),
        );
      },
    );
  }
}

class MeetingScheduleFields extends StatelessWidget {
  const MeetingScheduleFields({
    super.key,
    this.interval,
    this.onChanged,
    this.draft,
    this.onDraftChanged,
    this.allowUnscheduled = true,
    this.enabled = true,
  });

  /// Compatibility input for callers that already hold a validated interval.
  final MeetingInterval? interval;
  final ValueChanged<MeetingInterval?>? onChanged;
  final MeetingScheduleDraft? draft;
  final ValueChanged<MeetingScheduleDraft?>? onDraftChanged;
  final bool allowUnscheduled;
  final bool enabled;

  Future<void> _choose(
    BuildContext context, {
    required bool chooseStart,
    required MeetingScheduleDraft currentDraft,
  }) async {
    if (!enabled) return;
    final currentInterval = currentDraft.validatedInterval;
    final current = chooseStart
        ? currentDraft.start?.toLocal() ??
              DateTime.now().add(const Duration(hours: 1))
        : currentDraft.end?.toLocal() ??
              (currentDraft.start?.toLocal() ?? DateTime.now()).add(
                const Duration(hours: 1),
              );
    final day = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (day == null || !context.mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(current),
    );
    if (time == null || !context.mounted) return;
    final selected = DateTime(
      day.year,
      day.month,
      day.day,
      time.hour,
      time.minute,
    );
    final next = MeetingScheduleDraft(
      start: chooseStart ? selected : currentDraft.start,
      end: chooseStart ? currentDraft.end : selected,
    );
    if (onDraftChanged != null) {
      onDraftChanged!(next);
      return;
    }

    // Legacy callers accept only validated values. Never move the opposite
    // endpoint to make an invalid interval appear valid.
    final validated = next.validatedInterval;
    if (validated != null) {
      onChanged?.call(validated);
    } else if (currentInterval != null) {
      onChanged?.call(currentInterval);
    }
  }

  @override
  Widget build(BuildContext context) {
    final activeDraft =
        draft ??
        (onDraftChanged == null && interval != null
            ? MeetingScheduleDraft.fromInterval(interval)
            : null);
    final enabled = activeDraft != null;
    final displayDraft =
        activeDraft ?? const MeetingScheduleDraft(start: null, end: null);
    final validation = activeDraft?.validationMessage;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('Đặt thời gian cuộc họp'),
          subtitle: Text(
            enabled
                ? 'Giờ được gửi lên Core API theo UTC.'
                : 'Có thể để lịch chưa xác định.',
          ),
          value: enabled,
          onChanged: this.enabled && (allowUnscheduled || enabled)
              ? (turnOn) {
                  if (!turnOn) {
                    onDraftChanged?.call(null);
                    onChanged?.call(null);
                    return;
                  }
                  final start = DateTime.now().add(const Duration(hours: 1));
                  final initialized = MeetingScheduleDraft(
                    start: start,
                    end: start.add(const Duration(hours: 1)),
                  );
                  onDraftChanged?.call(initialized);
                  onChanged?.call(initialized.validatedInterval);
                }
              : null,
        ),
        if (enabled) ...[
          OutlinedButton.icon(
            onPressed: !this.enabled
                ? null
                : () => _choose(
                    context,
                    chooseStart: true,
                    currentDraft: displayDraft,
                  ),
            icon: const Icon(Icons.event),
            label: Text('Bắt đầu · ${dateLabel(displayDraft.start)}'),
          ),
          OutlinedButton.icon(
            onPressed: !this.enabled
                ? null
                : () => _choose(
                    context,
                    chooseStart: false,
                    currentDraft: displayDraft,
                  ),
            icon: const Icon(Icons.schedule),
            label: Text('Kết thúc · ${dateLabel(displayDraft.end)}'),
          ),
          if (validation != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                validation,
                style: const TextStyle(color: Palette.red, fontSize: 12),
              ),
            ),
        ],
      ],
    );
  }
}

class SchedulePreviewCard extends StatefulWidget {
  const SchedulePreviewCard({
    super.key,
    required this.repository,
    required this.sessionScope,
    required this.intent,
    this.participantDisplayNames = const <String, String>{},
    this.previewController,
  });

  final RoomSchedulingRepository repository;
  final AuthenticatedSessionScope sessionScope;
  final ScheduleIntent? intent;
  final Map<String, String> participantDisplayNames;
  final SchedulePreviewController? previewController;

  @override
  State<SchedulePreviewCard> createState() => _SchedulePreviewCardState();
}

class _SchedulePreviewCardState extends State<SchedulePreviewCard> {
  late final SchedulePreviewController _controller;
  late final bool _ownsController;

  @override
  void initState() {
    super.initState();
    _ownsController = widget.previewController == null;
    _controller =
        widget.previewController ??
        (SchedulePreviewController(
          repository: widget.repository,
          sessionScope: widget.sessionScope,
        )..setIntent(widget.intent));
  }

  @override
  void didUpdateWidget(covariant SchedulePreviewCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.intent != widget.intent) {
      _controller.setIntent(widget.intent);
    }
  }

  @override
  void dispose() {
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      final preview = state.preview;
      final outdated = state.phase == SchedulePreviewPhase.outdated;
      return ContentCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Xem trước lịch trình',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed:
                      widget.intent == null ||
                          state.phase == SchedulePreviewPhase.loading
                      ? null
                      : _controller.check,
                  icon: const Icon(Icons.fact_check_outlined),
                  label: Text(
                    state.phase == SchedulePreviewPhase.loading
                        ? 'Đang kiểm tra'
                        : 'Kiểm tra',
                  ),
                ),
              ],
            ),
            if (state.phase == SchedulePreviewPhase.notPerformed)
              const Text(
                'Chọn thời gian để kiểm tra lịch phòng và thành viên.',
              ),
            if (state.phase == SchedulePreviewPhase.loading)
              const LinearProgressIndicator(),
            if (state.phase == SchedulePreviewPhase.failed)
              Text(
                state.failure is ApiFailure
                    ? (state.failure! as ApiFailure).message
                    : 'Không thể kiểm tra lịch trình.',
                style: const TextStyle(color: Palette.red),
              ),
            if (outdated)
              const Text(
                'Bản xem trước đã cũ. Hãy kiểm tra lại với các giá trị hiện tại.',
                style: TextStyle(color: Palette.amber),
              ),
            if (preview != null &&
                state.phase == SchedulePreviewPhase.current) ...[
              Row(
                children: [
                  Icon(
                    preview.canSchedule
                        ? Icons.check_circle_outline
                        : Icons.warning_amber,
                    color: preview.canSchedule ? Palette.green : Palette.amber,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      preview.canSchedule
                          ? 'Lịch tạm thời phù hợp'
                          : 'Có xung đột hoặc điều kiện chưa đáp ứng',
                    ),
                  ),
                ],
              ),
              if (preview.roomConflict)
                const Text('Phòng họp có thể bị trùng lịch.'),
              ...preview.warnings.map(
                (warning) => Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    '• ${_warningMessage(warning, widget.participantDisplayNames)}',
                    style: const TextStyle(color: Palette.amber, fontSize: 12),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Đây chỉ là bản xem trước; lưu lịch vẫn được kiểm tra độc lập.',
                style: TextStyle(color: Palette.muted, fontSize: 12),
              ),
            ],
          ],
        ),
      );
    },
  );
}

String _warningMessage(
  ScheduleWarning warning,
  Map<String, String> participantDisplayNames,
) {
  switch (warning.code) {
    case 'PARTICIPANT_OVERLAP':
      final name = warning.userId == null
          ? null
          : participantDisplayNames[warning.userId!.toLowerCase()];
      return name == null || name.trim().isEmpty
          ? 'Người tham gia có lịch họp trùng.'
          : '$name có lịch họp trùng.';
    case 'CAPACITY_ADVISORY_EXCEEDED':
      return 'Số người tham gia vượt sức chứa tham khảo của phòng.';
    default:
      return 'Có một cảnh báo khác cần được xem xét.';
  }
}

String? _normalizeSearch(String value) {
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}
