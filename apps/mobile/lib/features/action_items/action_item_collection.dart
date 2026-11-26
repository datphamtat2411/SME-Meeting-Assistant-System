import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';

import 'action_item_models.dart';
import 'action_item_repository.dart';

enum ActionItemCollectionMode { myWork, allAccessible, needsReview }

enum ActionItemCollectionPhase { idle, initial, debounce, refresh, append }

enum ActionItemCollectionFailure { initial, refresh, append, changed, access }

/// User-selected filters. Fixed collection semantics are applied at the
/// query boundary, rather than filtering authorized server pages locally.
class ActionItemCollectionCriteria {
  const ActionItemCollectionCriteria({
    this.mode = ActionItemCollectionMode.myWork,
    this.search = '',
    this.status,
    this.meetingId,
    this.assignee,
    this.overdue,
    this.sortField = ActionItemSortField.createdAt,
    this.sortDirection = ActionItemSortDirection.desc,
  });

  final ActionItemCollectionMode mode;
  final String search;
  final ActionItemStatus? status;
  final String? meetingId;
  final ActionItemAssigneeFilter? assignee;
  final bool? overdue;
  final ActionItemSortField sortField;
  final ActionItemSortDirection sortDirection;

  ActionItemQuery query({int page = 0, String? fixedMeetingId}) {
    final mine = mode == ActionItemCollectionMode.myWork;
    final review = mode == ActionItemCollectionMode.needsReview;
    return ActionItemQuery(
      meetingId: fixedMeetingId ?? meetingId,
      search: search,
      status: review
          ? ActionItemStatus.proposed
          : mine && status == ActionItemStatus.proposed
          ? null
          : status,
      assignee: mine ? const ActionItemAssigneeFilter.me() : assignee,
      official: mine ? true : null,
      reviewable: review ? true : null,
      overdue: review && overdue == true ? null : overdue,
      sortField: sortField,
      sortDirection: sortDirection,
      page: page,
    );
  }
}

class ActionItemCollectionState {
  const ActionItemCollectionState({
    required this.criteria,
    required this.items,
    required this.phase,
    required this.loaded,
    required this.hasMore,
    required this.totalElements,
    required this.failure,
    required this.error,
  });

  final ActionItemCollectionCriteria criteria;
  final List<ActionItemResource> items;
  final ActionItemCollectionPhase phase;
  final bool loaded;
  final bool hasMore;
  final int? totalElements;
  final ActionItemCollectionFailure? failure;
  final Object? error;

  bool get isConfirmedEmpty =>
      loaded &&
      items.isEmpty &&
      phase == ActionItemCollectionPhase.idle &&
      failure == null;
}

/// One session-bound owner for a collection. Each generation owns its page
/// window and at most one admitted request. Refresh replaces pages atomically.
class ActionItemCollectionController extends ChangeNotifier {
  ActionItemCollectionController({
    required this.repository,
    this.fixedMeetingId,
    ActionItemCollectionCriteria criteria =
        const ActionItemCollectionCriteria(),
    this.searchDebounce = const Duration(milliseconds: 300),
    bool active = true,
  }) : _criteria = criteria,
       _scope = repository.captureSession(),
       _active = active {
    criteria.query(fixedMeetingId: fixedMeetingId);
    _revision = repository.invalidation.revision;
    repository.invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final ActionItemRepository repository;
  final String? fixedMeetingId;
  final Duration searchDebounce;
  final AuthenticatedSessionScope _scope;
  ActionItemCollectionCriteria _criteria;
  PageWindow<ActionItemResource> _window = PageWindow<ActionItemResource>();
  List<ActionItemResource> _items = const [];
  ActionItemCollectionPhase _phase = ActionItemCollectionPhase.idle;
  ActionItemCollectionFailure? _failure;
  Object? _error;
  int? _total;
  bool _loaded = false;
  bool _active;
  bool _dirty = false;
  bool _disposed = false;
  bool _invalidSession = false;
  int _generation = 0;
  late int _revision;
  Timer? _timer;
  Future<void>? _operation;

  ActionItemCollectionState get state => ActionItemCollectionState(
    criteria: _criteria,
    items: _items,
    phase: _phase,
    loaded: _loaded,
    hasMore:
        !_invalidSession &&
        _window.hasMore &&
        _failure != ActionItemCollectionFailure.changed &&
        _failure != ActionItemCollectionFailure.refresh &&
        _failure != ActionItemCollectionFailure.access,
    totalElements: _total,
    failure: _failure,
    error: _error,
  );

  bool get _current =>
      !_disposed &&
      !_invalidSession &&
      repository.api.isCurrentAuthenticatedSession(_scope);

  Future<void> initialize() {
    if (!_current || !_active || _loaded) return Future<void>.value();
    return _operation ?? _start();
  }

  Future<void> applyCriteria(
    ActionItemCollectionCriteria criteria, {
    bool debounce = false,
  }) {
    if (!_current) return Future<void>.value();
    criteria.query(fixedMeetingId: fixedMeetingId);
    _criteria = criteria;
    _reset(preserve: false);
    if (!_active) {
      _dirty = true;
      notifyListeners();
      return Future<void>.value();
    }
    if (!debounce) return _start();
    _phase = ActionItemCollectionPhase.debounce;
    _timer = Timer(searchDebounce, () {
      _timer = null;
      if (_current && _active) unawaited(_start());
    });
    notifyListeners();
    return Future<void>.value();
  }

  Future<void> refresh() {
    if (!_current) return Future<void>.value();
    if (!_active) {
      _dirty = true;
      return Future<void>.value();
    }
    if (_operation != null && _window.nextPage == 0) {
      return _operation!;
    }
    _reset(preserve: true);
    return _start();
  }

  Future<void> loadMore() {
    if (!_current || !_active || !_loaded || _timer != null) {
      return Future<void>.value();
    }
    if (_operation != null) return _operation!;
    if (!state.hasMore || _failure != null) return Future<void>.value();
    return _start();
  }

  Future<void> retry() {
    if (!_current || !_active) return Future<void>.value();
    if (_operation != null) return _operation!;
    if (_failure == ActionItemCollectionFailure.append) return _start();
    return refresh();
  }

  void setActive(bool active) {
    if (!_current || _active == active) return;
    _active = active;
    if (!active) {
      if (_timer != null) {
        _timer!.cancel();
        _timer = null;
        _phase = ActionItemCollectionPhase.idle;
        _dirty = true;
        notifyListeners();
      }
      return;
    }
    if (_dirty || !_loaded) unawaited(refresh());
  }

  void _reset({required bool preserve}) {
    _generation++;
    _timer?.cancel();
    _timer = null;
    _operation = null;
    _window = PageWindow<ActionItemResource>();
    _phase = ActionItemCollectionPhase.idle;
    _failure = null;
    _error = null;
    if (!preserve) {
      _items = const [];
      _total = null;
      _loaded = false;
    }
  }

  Future<void> _start() {
    if (!_current || !_active) return Future<void>.value();
    if (_operation != null) return _operation!;
    final window = _window;
    final token = window.beginRequest();
    final generation = _generation;
    final query = _criteria.query(
      page: token.page,
      fixedMeetingId: fixedMeetingId,
    );
    if (token.page == 0) _dirty = false;
    _phase = token.page > 0
        ? ActionItemCollectionPhase.append
        : _loaded
        ? ActionItemCollectionPhase.refresh
        : ActionItemCollectionPhase.initial;
    _failure = null;
    _error = null;
    final completion = Completer<void>();
    _operation = completion.future;
    notifyListeners();
    unawaited(_load(window, token, generation, query, completion));
    return completion.future;
  }

  bool _owns(int generation) => _current && generation == _generation;

  Future<void> _load(
    PageWindow<ActionItemResource> window,
    PageRequestToken token,
    int generation,
    ActionItemQuery query,
    Completer<void> completion,
  ) async {
    try {
      if (!_owns(generation)) return;
      final page = await repository.list(query, sessionScope: _scope);
      if (!_owns(generation)) return;
      final seen = window.items.map((item) => item.id.toLowerCase()).toSet();
      final duplicate = page.items.any(
        (item) => !seen.add(item.id.toLowerCase()),
      );
      final remaining = page.totalElements - page.page * page.size;
      final expected = remaining <= 0
          ? 0
          : remaining < page.size
          ? remaining
          : page.size;
      final changed =
          duplicate ||
          page.items.length != expected ||
          (window.totalElements != null &&
              window.totalElements != page.totalElements) ||
          (window.totalPages != null && window.totalPages != page.totalPages);
      if (changed) {
        // Preserve the previous verified view, but do not append inconsistent
        // offsets or advertise that the resulting collection is complete.
        _failure = ActionItemCollectionFailure.changed;
        return;
      }
      if (!window.accept(
        page,
        request: token,
        identity: (item) => item.id.toLowerCase(),
      )) {
        return;
      }
      _items = window.items;
      _total = page.totalElements;
      _loaded = true;
    } catch (error) {
      if (!_owns(generation)) return;
      _error = error;
      if (error is ActionItemFailure &&
          (error.category == ActionItemFailureCategory.authentication ||
              error.category == ActionItemFailureCategory.authorization ||
              error.category == ActionItemFailureCategory.resourceUnavailable)) {
        _items = const [];
        _total = null;
        _loaded = false;
        _window = PageWindow<ActionItemResource>();
        _failure = ActionItemCollectionFailure.access;
      } else {
        _failure = token.page > 0
            ? ActionItemCollectionFailure.append
            : _loaded
            ? ActionItemCollectionFailure.refresh
            : ActionItemCollectionFailure.initial;
      }
    } finally {
      if (_owns(generation)) {
        _operation = null;
        _phase = ActionItemCollectionPhase.idle;
        notifyListeners();
        _drainInvalidation();
      }
      completion.complete();
    }
  }

  void _onInvalidation() {
    if (!_current) {
      _onSessionChanged();
      return;
    }
    final revision = repository.invalidation.revision;
    if (revision == _revision) return;
    _revision = revision;
    _dirty = true;
    _drainInvalidation();
  }

  void _drainInvalidation() {
    if (_current &&
        _active &&
        _dirty &&
        _timer == null &&
        _operation == null) {
      unawaited(refresh());
    }
  }

  void _onSessionChanged() {
    if (_disposed || _invalidSession || _current) return;
    _invalidSession = true;
    _dirty = false;
    _reset(preserve: false);
    _failure = ActionItemCollectionFailure.access;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _timer?.cancel();
    repository.invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_onSessionChanged);
    super.dispose();
  }
}
