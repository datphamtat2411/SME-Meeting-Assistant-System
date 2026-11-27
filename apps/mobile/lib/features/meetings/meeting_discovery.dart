import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

const int meetingListPageSize = 20;
const int calendarPageSize = 100;
const int calendarPageBatchLimit = 30;

class MeetingDiscoveryState {
  const MeetingDiscoveryState({
    required this.items,
    required this.searchInput,
    required this.appliedQuery,
    required this.initialLoading,
    required this.refreshing,
    required this.loadingMore,
    required this.hasMore,
    required this.collectionChanged,
    required this.hasLoaded,
    required this.totalElements,
    required this.loadingFailure,
    required this.refreshFailure,
  });

  final List<MeetingListProjection> items;
  final String searchInput;
  final MeetingQuery appliedQuery;
  final bool initialLoading;
  final bool refreshing;
  final bool loadingMore;
  final bool hasMore;
  final bool collectionChanged;
  final bool hasLoaded;
  final int? totalElements;
  final Object? loadingFailure;
  final Object? refreshFailure;

  bool get isConfirmedEmpty =>
      hasLoaded &&
      items.isEmpty &&
      !initialLoading &&
      !refreshing &&
      loadingFailure == null &&
      refreshFailure == null &&
      !collectionChanged;
}

class MeetingDiscoveryController extends ChangeNotifier {
  MeetingDiscoveryController({
    required this.repository,
    required this.invalidation,
  }) : _query = MeetingQuery(),
       _state = MeetingDiscoveryState(
         items: const <MeetingListProjection>[],
         searchInput: '',
         appliedQuery: MeetingQuery(),
         initialLoading: true,
         refreshing: false,
         loadingMore: false,
         hasMore: true,
         collectionChanged: false,
         hasLoaded: false,
         totalElements: null,
         loadingFailure: null,
         refreshFailure: null,
       ),
       _sessionScope = repository.api.authenticatedSessionScope {
    _seenInvalidationRevision = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final MeetingRepository repository;
  final MeetingInvalidationSignal invalidation;
  final AuthenticatedSessionScope? _sessionScope;
  MeetingQuery _query;
  MeetingDiscoveryState _state;
  PageWindow<MeetingListProjection> _window =
      PageWindow<MeetingListProjection>();
  final LinkedHashMap<String, MeetingListProjection> _itemsById =
      LinkedHashMap<String, MeetingListProjection>();
  final Map<String, Future<void>> _operations = <String, Future<void>>{};
  int? _expectedTotalElements;
  int? _expectedTotalPages;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  bool _disposed = false;

  MeetingDiscoveryState get state => _state;

  String get searchInput => _state.searchInput;

  void setSearchInput(String value) {
    if (_disposed) return;
    _state = _copy(searchInput: value);
    notifyListeners();
  }

  Future<void> applyQuery({
    String? search,
    MeetingStatus? status,
    MeetingRelationship? relationship,
    MeetingSortField sort = MeetingSortField.createdAt,
    MeetingSortDirection direction = MeetingSortDirection.descending,
  }) {
    if (search != null && search.length > 200) {
      throw ArgumentError.value(
        search,
        'search',
        'Must be at most 200 characters.',
      );
    }
    final normalized = search?.trim();
    final next = MeetingQuery(
      search: normalized == null || normalized.isEmpty ? null : normalized,
      status: status,
      relationship: relationship,
      page: 0,
      size: meetingListPageSize,
      sort: sort,
      direction: direction,
    );
    if (_sameMeetingQuery(_query, next) && _state.hasLoaded) {
      return Future<void>.value();
    }
    _query = next;
    _resetForNewQuery();
    return _fetchPage(refresh: false);
  }

  Future<void> initialize() {
    if (_state.hasLoaded || _state.initialLoading == false) {
      return Future<void>.value();
    }
    return _fetchPage(refresh: false);
  }

  Future<void> refresh() {
    if (_disposed || _sessionScope == null) return Future<void>.value();
    _generation++;
    _window = PageWindow<MeetingListProjection>();
    _itemsById.clear();
    _expectedTotalElements = null;
    _expectedTotalPages = null;
    _state = _copy(
      items: _state.items,
      refreshing: _state.hasLoaded,
      initialLoading: !_state.hasLoaded,
      loadingMore: false,
      hasMore: true,
      collectionChanged: false,
      clearLoadingFailure: true,
      clearRefreshFailure: true,
    );
    notifyListeners();
    return _fetchPage(refresh: _state.hasLoaded);
  }

  Future<void> loadMore() {
    if (_disposed ||
        !_state.hasMore ||
        _state.collectionChanged ||
        _state.initialLoading ||
        _state.refreshing ||
        _state.loadingMore ||
        _state.loadingFailure != null) {
      return Future<void>.value();
    }
    return _fetchPage(refresh: false);
  }

  Future<void> retry() {
    if (_state.refreshFailure != null ||
        (!_state.hasLoaded && _state.loadingFailure != null)) {
      return refresh();
    }
    if (_state.loadingFailure != null) {
      _state = _copy(loadingFailure: null);
      notifyListeners();
      return _fetchPage(refresh: false);
    }
    return loadMore();
  }

  void _resetForNewQuery() {
    _generation++;
    _window = PageWindow<MeetingListProjection>();
    _itemsById.clear();
    _expectedTotalElements = null;
    _expectedTotalPages = null;
    _state = MeetingDiscoveryState(
      items: const <MeetingListProjection>[],
      searchInput: _state.searchInput,
      appliedQuery: _query,
      initialLoading: true,
      refreshing: false,
      loadingMore: false,
      hasMore: true,
      collectionChanged: false,
      hasLoaded: false,
      totalElements: null,
      loadingFailure: null,
      refreshFailure: null,
    );
    notifyListeners();
  }

  Future<void> _fetchPage({required bool refresh}) {
    if (_disposed || _sessionScope == null) return Future<void>.value();
    final generation = _generation;
    final pageNumber = _window.nextPage;
    final operationKey = '$generation:$pageNumber';
    final pending = _operations[operationKey];
    if (pending != null) return pending;
    final request = _window.beginRequest();
    _state = _copy(
      initialLoading: pageNumber == 0 && !_state.hasLoaded && !refresh,
      refreshing: refresh && pageNumber == 0,
      loadingMore: pageNumber > 0,
      clearLoadingFailure: true,
      clearRefreshFailure: true,
    );
    notifyListeners();
    late final Future<void> operation;
    operation = _loadPage(request, generation, refresh: refresh).whenComplete(
      () {
        _operations.remove(operationKey);
      },
    );
    _operations[operationKey] = operation;
    return operation;
  }

  Future<void> _loadPage(
    PageRequestToken request,
    int generation, {
    required bool refresh,
  }) async {
    final scope = _sessionScope;
    if (scope == null) return;
    try {
      final query = MeetingQuery(
        search: _query.search,
        status: _query.status,
        relationship: _query.relationship,
        from: _query.from,
        to: _query.to,
        page: request.page,
        size: meetingListPageSize,
        sort: _query.sort,
        direction: _query.direction,
      );
      final page = await repository.list(query: query);
      if (!_owns(generation, scope)) return;
      final totalsChanged =
          (_expectedTotalElements != null &&
              _expectedTotalElements != page.totalElements) ||
          (_expectedTotalPages != null &&
              _expectedTotalPages != page.totalPages);
      _expectedTotalElements ??= page.totalElements;
      _expectedTotalPages ??= page.totalPages;
      if (request.page == 0) _itemsById.clear();
      final seenIds = _itemsById.keys.toSet();
      var duplicate = false;
      for (final entry in page.items) {
        final id = entry.meeting.id.toLowerCase();
        if (!seenIds.add(id)) duplicate = true;
        _itemsById[id] = entry;
      }
      _window.accept(page, request: request);
      final collectionChanged = totalsChanged || duplicate;
      _state = _copy(
        items: List<MeetingListProjection>.unmodifiable(_itemsById.values),
        initialLoading: false,
        refreshing: false,
        loadingMore: false,
        hasMore: _window.hasMore && !collectionChanged,
        collectionChanged: collectionChanged,
        hasLoaded: true,
        totalElements: page.totalElements,
        clearLoadingFailure: true,
        clearRefreshFailure: true,
      );
    } catch (error) {
      if (!_owns(generation, scope)) return;
      if (refresh) {
        _state = _copy(
          initialLoading: false,
          refreshing: false,
          loadingMore: false,
          hasMore: false,
          collectionChanged: _state.items.isNotEmpty,
          refreshFailure: error,
        );
      } else {
        _state = _copy(
          initialLoading: false,
          refreshing: false,
          loadingMore: false,
          loadingFailure: error,
        );
      }
    } finally {
      if (_owns(generation, scope)) notifyListeners();
    }
  }

  MeetingDiscoveryState _copy({
    List<MeetingListProjection>? items,
    String? searchInput,
    MeetingQuery? appliedQuery,
    bool? initialLoading,
    bool? refreshing,
    bool? loadingMore,
    bool? hasMore,
    bool? collectionChanged,
    bool? hasLoaded,
    int? totalElements,
    Object? loadingFailure,
    bool clearLoadingFailure = false,
    Object? refreshFailure,
    bool clearRefreshFailure = false,
  }) => MeetingDiscoveryState(
    items: items ?? _state.items,
    searchInput: searchInput ?? _state.searchInput,
    appliedQuery: appliedQuery ?? _state.appliedQuery,
    initialLoading: initialLoading ?? _state.initialLoading,
    refreshing: refreshing ?? _state.refreshing,
    loadingMore: loadingMore ?? _state.loadingMore,
    hasMore: hasMore ?? _state.hasMore,
    collectionChanged: collectionChanged ?? _state.collectionChanged,
    hasLoaded: hasLoaded ?? _state.hasLoaded,
    totalElements: totalElements ?? _state.totalElements,
    loadingFailure: clearLoadingFailure
        ? null
        : loadingFailure ?? _state.loadingFailure,
    refreshFailure: clearRefreshFailure
        ? null
        : refreshFailure ?? _state.refreshFailure,
  );

  bool _owns(int generation, AuthenticatedSessionScope scope) =>
      !_disposed &&
      generation == _generation &&
      repository.api.isCurrentAuthenticatedSession(scope);

  void _onInvalidation() {
    if (_disposed) return;
    if (_sessionScope == null ||
        !repository.api.isCurrentAuthenticatedSession(_sessionScope)) {
      _clearProtectedState();
      return;
    }
    if (_seenInvalidationRevision == invalidation.revision) return;
    _seenInvalidationRevision = invalidation.revision;
    unawaited(refresh());
  }

  void _onSessionChanged() {
    if (_disposed ||
        (_sessionScope != null &&
            repository.api.isCurrentAuthenticatedSession(_sessionScope))) {
      return;
    }
    _clearProtectedState();
  }

  void _clearProtectedState() {
    _generation++;
    _window = PageWindow<MeetingListProjection>();
    _itemsById.clear();
    _state = MeetingDiscoveryState(
      items: const <MeetingListProjection>[],
      searchInput: '',
      appliedQuery: _query,
      initialLoading: false,
      refreshing: false,
      loadingMore: false,
      hasMore: false,
      collectionChanged: false,
      hasLoaded: false,
      totalElements: null,
      loadingFailure: null,
      refreshFailure: null,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_onSessionChanged);
    _operations.clear();
    super.dispose();
  }
}

class CalendarMonthRange {
  const CalendarMonthRange({required this.startLocal, required this.endLocal});

  final DateTime startLocal;
  final DateTime endLocal;

  factory CalendarMonthRange.fromDate(DateTime date) => CalendarMonthRange(
    startLocal: DateTime(date.year, date.month),
    endLocal: DateTime(date.year, date.month + 1),
  );

  DateTime get startUtc => startLocal.toUtc();
  DateTime get endUtc => endLocal.toUtc();
}

class MeetingCalendarState {
  const MeetingCalendarState({
    required this.month,
    required this.relationship,
    required this.status,
    required this.entries,
    required this.isLoading,
    required this.isRefreshing,
    required this.hasMore,
    required this.incomplete,
    required this.collectionChanged,
    required this.failure,
    required this.loadedPageCount,
  });

  final DateTime month;
  final MeetingRelationship? relationship;
  final MeetingStatus? status;
  final List<MeetingListProjection> entries;
  final bool isLoading;
  final bool isRefreshing;
  final bool hasMore;
  final bool incomplete;
  final bool collectionChanged;
  final Object? failure;
  final int loadedPageCount;

  bool get isConfirmedEmpty =>
      !isLoading &&
      !isRefreshing &&
      !incomplete &&
      failure == null &&
      visibleEntries.isEmpty;

  List<MeetingListProjection> get visibleEntries {
    final filtered = entries.where((entry) {
      if (status == null &&
          entry.meeting.lifecycleStatus == MeetingStatus.cancelled) {
        return false;
      }
      return true;
    });
    return stableChronologicalMeetings(filtered.toList());
  }
}

class MeetingCalendarController extends ChangeNotifier {
  MeetingCalendarController({
    required this.repository,
    required this.invalidation,
    DateTime? initialMonth,
  }) : _state = MeetingCalendarState(
         month: DateTime(
           (initialMonth ?? DateTime.now()).year,
           (initialMonth ?? DateTime.now()).month,
         ),
         relationship: null,
         status: null,
         entries: const <MeetingListProjection>[],
         isLoading: true,
         isRefreshing: false,
         hasMore: true,
         incomplete: false,
         collectionChanged: false,
         failure: null,
         loadedPageCount: 0,
       ),
       _sessionScope = repository.api.authenticatedSessionScope {
    _seenInvalidationRevision = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final MeetingRepository repository;
  final MeetingInvalidationSignal invalidation;
  final AuthenticatedSessionScope? _sessionScope;
  MeetingCalendarState _state;
  PageWindow<MeetingListProjection> _window =
      PageWindow<MeetingListProjection>();
  final LinkedHashMap<String, MeetingListProjection> _entriesById =
      LinkedHashMap<String, MeetingListProjection>();
  int? _expectedTotalElements;
  int? _expectedTotalPages;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  Future<void>? _batchOperation;
  int? _batchGeneration;
  bool _disposed = false;

  MeetingCalendarState get state => _state;
  CalendarMonthRange get range => CalendarMonthRange.fromDate(_state.month);

  Future<void> initialize() => _loadBatch(refresh: false);

  Future<void> setMonth(DateTime month) {
    final normalized = DateTime(month.year, month.month);
    if (normalized.year == _state.month.year &&
        normalized.month == _state.month.month) {
      return Future<void>.value();
    }
    _reset(
      month: normalized,
      relationship: _state.relationship,
      status: _state.status,
    );
    return _loadBatch(refresh: false);
  }

  Future<void> setFilters({
    MeetingRelationship? relationship,
    MeetingStatus? status,
  }) {
    if (relationship == _state.relationship && status == _state.status) {
      return Future<void>.value();
    }
    _reset(month: _state.month, relationship: relationship, status: status);
    return _loadBatch(refresh: false);
  }

  Future<void> refresh() {
    _reset(
      month: _state.month,
      relationship: _state.relationship,
      status: _state.status,
      refreshing: true,
    );
    return _loadBatch(refresh: true);
  }

  Future<void> continueLoading() {
    if (_disposed ||
        !_state.hasMore ||
        _state.isLoading ||
        _state.isRefreshing ||
        _state.collectionChanged) {
      return Future<void>.value();
    }
    return _loadBatch(refresh: false);
  }

  Future<void> retry() {
    if (_state.failure != null && !_state.hasMore) return refresh();
    return continueLoading();
  }

  void _reset({
    required DateTime month,
    required MeetingRelationship? relationship,
    required MeetingStatus? status,
    bool refreshing = false,
  }) {
    _generation++;
    _window = PageWindow<MeetingListProjection>();
    _entriesById.clear();
    _expectedTotalElements = null;
    _expectedTotalPages = null;
    _state = MeetingCalendarState(
      month: month,
      relationship: relationship,
      status: status,
      entries: const <MeetingListProjection>[],
      isLoading: !refreshing,
      isRefreshing: refreshing,
      hasMore: true,
      incomplete: false,
      collectionChanged: false,
      failure: null,
      loadedPageCount: 0,
    );
    notifyListeners();
  }

  Future<void> _loadBatch({required bool refresh}) {
    final generation = _generation;
    if (_batchOperation != null && _batchGeneration == generation) {
      return _batchOperation!;
    }
    final completer = Completer<void>();
    final operation = completer.future;
    _batchGeneration = generation;
    _batchOperation = operation;
    unawaited(
      _runBatch(refresh: refresh, generation: generation).then(
        (_) {
          if (_batchGeneration == generation) {
            _batchOperation = null;
            _batchGeneration = null;
          }
          completer.complete();
        },
        onError: (Object error, StackTrace stackTrace) {
          if (_batchGeneration == generation) {
            _batchOperation = null;
            _batchGeneration = null;
          }
          completer.completeError(error, stackTrace);
        },
      ),
    );
    return operation;
  }

  Future<void> _runBatch({
    required bool refresh,
    required int generation,
  }) async {
    final scope = _sessionScope;
    if (_disposed || scope == null) return;
    final range = CalendarMonthRange.fromDate(_state.month);
    _state = _copy(
      isLoading: !refresh,
      isRefreshing: refresh,
      clearFailure: true,
    );
    notifyListeners();
    var loadedThisBatch = 0;
    try {
      while (_window.hasMore && loadedThisBatch < calendarPageBatchLimit) {
        final token = _window.beginRequest();
        final query = MeetingQuery(
          status: _state.status,
          relationship: _state.relationship,
          from: range.startLocal,
          to: range.endLocal,
          page: token.page,
          size: calendarPageSize,
          sort: MeetingSortField.scheduledStartAt,
          direction: MeetingSortDirection.ascending,
        );
        final page = await repository.list(query: query);
        if (!_owns(generation, scope)) return;
        final totalsChanged =
            (_expectedTotalElements != null &&
                _expectedTotalElements != page.totalElements) ||
            (_expectedTotalPages != null &&
                _expectedTotalPages != page.totalPages);
        _expectedTotalElements ??= page.totalElements;
        _expectedTotalPages ??= page.totalPages;
        final seen = _entriesById.keys.toSet();
        var duplicate = false;
        for (final entry in page.items) {
          final id = entry.meeting.id.toLowerCase();
          if (!seen.add(id)) duplicate = true;
          _entriesById[id] = entry;
        }
        _window.accept(page, request: token);
        loadedThisBatch++;
        final changed = totalsChanged || duplicate;
        _state = _copy(
          entries: stableChronologicalMeetings(_entriesById.values),
          isLoading: true,
          isRefreshing: refresh,
          hasMore: _window.hasMore && !changed,
          incomplete: _window.hasMore || changed,
          collectionChanged: changed,
          clearFailure: true,
          loadedPageCount: _state.loadedPageCount + 1,
        );
        notifyListeners();
        if (changed) break;
      }
      if (_owns(generation, scope)) {
        _state = _copy(
          isLoading: false,
          isRefreshing: false,
          hasMore: _window.hasMore && !_state.collectionChanged,
          incomplete: _window.hasMore || _state.collectionChanged,
        );
        notifyListeners();
      }
    } catch (error) {
      if (!_owns(generation, scope)) return;
      _state = _copy(
        isLoading: false,
        isRefreshing: false,
        hasMore: _window.hasMore,
        incomplete: true,
        failure: error,
      );
      notifyListeners();
    } finally {
      if (_owns(generation, scope)) {
        _state = _copy(isLoading: false, isRefreshing: false);
        notifyListeners();
      }
    }
  }

  MeetingCalendarState _copy({
    DateTime? month,
    MeetingRelationship? relationship,
    MeetingStatus? status,
    List<MeetingListProjection>? entries,
    bool? isLoading,
    bool? isRefreshing,
    bool? hasMore,
    bool? incomplete,
    bool? collectionChanged,
    Object? failure,
    bool clearFailure = false,
    int? loadedPageCount,
  }) => MeetingCalendarState(
    month: month ?? _state.month,
    relationship: relationship ?? _state.relationship,
    status: status ?? _state.status,
    entries: entries ?? _state.entries,
    isLoading: isLoading ?? _state.isLoading,
    isRefreshing: isRefreshing ?? _state.isRefreshing,
    hasMore: hasMore ?? _state.hasMore,
    incomplete: incomplete ?? _state.incomplete,
    collectionChanged: collectionChanged ?? _state.collectionChanged,
    failure: clearFailure ? null : failure ?? _state.failure,
    loadedPageCount: loadedPageCount ?? _state.loadedPageCount,
  );

  bool _owns(int generation, AuthenticatedSessionScope scope) =>
      !_disposed &&
      generation == _generation &&
      repository.api.isCurrentAuthenticatedSession(scope);

  void _onInvalidation() {
    if (_disposed) return;
    if (_sessionScope == null ||
        !repository.api.isCurrentAuthenticatedSession(_sessionScope)) {
      _clearProtectedState();
      return;
    }
    if (_seenInvalidationRevision == invalidation.revision) return;
    _seenInvalidationRevision = invalidation.revision;
    unawaited(refresh());
  }

  void _onSessionChanged() {
    if (_disposed ||
        (_sessionScope != null &&
            repository.api.isCurrentAuthenticatedSession(_sessionScope))) {
      return;
    }
    _clearProtectedState();
  }

  void _clearProtectedState() {
    _generation++;
    _window = PageWindow<MeetingListProjection>();
    _entriesById.clear();
    _state = MeetingCalendarState(
      month: _state.month,
      relationship: null,
      status: null,
      entries: const <MeetingListProjection>[],
      isLoading: false,
      isRefreshing: false,
      hasMore: false,
      incomplete: false,
      collectionChanged: false,
      failure: null,
      loadedPageCount: 0,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_onSessionChanged);
    super.dispose();
  }
}

bool meetingIntersectsLocalDay(Meeting meeting, DateTime localDay) {
  final start = meeting.scheduledStartAt;
  final end = meeting.scheduledEndAt;
  if (start == null || end == null) return false;
  final dayStart = DateTime(localDay.year, localDay.month, localDay.day);
  final nextDayStart = DateTime(
    localDay.year,
    localDay.month,
    localDay.day + 1,
  );
  final localStart = start.toLocal();
  final localEnd = end.toLocal();
  return localStart.isBefore(nextDayStart) && dayStart.isBefore(localEnd);
}

List<MeetingListProjection> stableChronologicalMeetings(
  Iterable<MeetingListProjection> meetings,
) {
  final unique = <String, MeetingListProjection>{};
  for (final projection in meetings) {
    unique[projection.meeting.id.toLowerCase()] = projection;
  }
  final result = unique.values.toList();
  result.sort((first, second) {
    final firstStart = first.meeting.scheduledStartAt;
    final secondStart = second.meeting.scheduledStartAt;
    if (firstStart == null || secondStart == null) {
      if (firstStart != null) return -1;
      if (secondStart != null) return 1;
    } else {
      final byStart = firstStart.compareTo(secondStart);
      if (byStart != 0) return byStart;
    }
    return first.meeting.id.toLowerCase().compareTo(
      second.meeting.id.toLowerCase(),
    );
  });
  return List<MeetingListProjection>.unmodifiable(result);
}

bool _sameMeetingQuery(MeetingQuery first, MeetingQuery second) =>
    first.search == second.search &&
    first.status == second.status &&
    first.relationship == second.relationship &&
    first.sort == second.sort &&
    first.direction == second.direction &&
    first.organizerId == second.organizerId &&
    first.roomId == second.roomId &&
    first.from == second.from &&
    first.to == second.to;
