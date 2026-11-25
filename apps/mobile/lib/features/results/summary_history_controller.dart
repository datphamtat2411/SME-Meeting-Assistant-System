import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../../core/paged_collection.dart';
import 'results_invalidation.dart';
import 'results_models.dart';
import 'results_repository.dart';

enum SummaryHistoryPhase {
  uninitialized,
  loading,
  available,
  empty,
  refreshing,
  failed,
  forbidden,
}

/// Summary-owned pagination state. The workspace remains the authorization and
/// invalidation owner; this controller owns page ordering and history content.
abstract interface class SummaryHistoryAccess implements Listenable {
  bool get canReadHistory;
  bool ownsRead(int epoch);
  int get readEpoch;
  ResultsRepository get repository;
  AuthenticatedSessionScope get sessionScope;
  String get meetingId;
  ResultsInvalidationSignal get invalidation;
  ResultsSummary? get currentSummaryForHistory;
  Future<void> handleProtectedReadFailure(ApiFailure failure, {required int epoch});
}

class SummaryHistoryController extends ChangeNotifier {
  SummaryHistoryController(this.workspace) {
    workspace.addListener(_workspaceChanged);
    workspace.invalidation.addListener(_invalidationChanged);
  }

  final SummaryHistoryAccess workspace;
  PageWindow<SummaryVersion> _pages = PageWindow<SummaryVersion>();
  Future<void>? _request;
  int _generation = 0;
  bool _active = false;
  bool _dirty = true;
  String? _selectionTag;
  String? _observedTag;
  bool _disposed = false;
  bool _recoveringRead = false;
  SummaryHistoryPhase phase = SummaryHistoryPhase.uninitialized;
  Object? failure;

  List<SummaryVersion> get items => workspace.canReadHistory ? _pages.items : const [];
  bool get hasMore => workspace.canReadHistory && _pages.hasMore;
  bool get isLoading =>
      phase == SummaryHistoryPhase.loading ||
      phase == SummaryHistoryPhase.refreshing;

  void setActive(bool active) {
    if (_disposed) return;
    _active = active;
    if (active && workspace.canReadHistory && _dirty) {
      unawaited(load(refresh: true));
    }
  }

  Future<void> load({bool refresh = false}) {
    if (_disposed) return Future<void>.value();
    if (!workspace.canReadHistory) {
      _clear(SummaryHistoryPhase.forbidden);
      return Future<void>.value();
    }
    if (_request != null) return _request!;
    final replace = refresh || _dirty;
    if (!replace && !_pages.hasMore) return Future<void>.value();
    final target = replace ? PageWindow<SummaryVersion>() : _pages;
    final token = target.beginRequest();
    final generation = _generation;
    final epoch = workspace.readEpoch;
    phase = _pages.items.isEmpty
        ? SummaryHistoryPhase.loading
        : SummaryHistoryPhase.refreshing;
    failure = null;
    final completion = Completer<void>();
    final operation = completion.future;
    _request = operation;
    notifyListeners();
    unawaited(
      _loadPage(target, token, generation, epoch, replace: replace)
          .whenComplete(() {
            if (identical(_request, operation)) _request = null;
            completion.complete();
            if (!_disposed && _active && workspace.canReadHistory &&
                generation != _generation && _request == null &&
                !_recoveringRead && _dirty &&
                phase != SummaryHistoryPhase.failed) {
              unawaited(load(refresh: true));
            }
          }),
    );
    return operation;
  }

  Future<void> loadMore() => load();

  bool _owns(int generation, int epoch) =>
      !_disposed && generation == _generation && workspace.ownsRead(epoch);

  Future<void> _loadPage(
    PageWindow<SummaryVersion> target,
    PageRequestToken token,
    int generation,
    int readEpoch, {
    required bool replace,
  }) async {
    try {
      final before = workspace.currentSummaryForHistory;
      final page = await workspace.repository.summaryVersions(
        sessionScope: workspace.sessionScope,
        meetingId: workspace.meetingId,
        page: token.page,
        size: 20,
      );
      if (!_owns(generation, readEpoch)) return;
      ResultsSummary? current;
      if (page.items.isNotEmpty || !replace) {
        final canonical = await workspace.repository.currentSummary(
          sessionScope: workspace.sessionScope,
          meetingId: workspace.meetingId,
        );
        if (!_owns(generation, readEpoch)) return;
        if ((before != null && before.etag != canonical.etag) ||
            (!replace && _selectionTag != canonical.etag) ||
            page.items.any((item) =>
                item.isCurrent != (item.id == canonical.id))) {
          throw _changed();
        }
        current = canonical;
      }
      if (!replace &&
          (page.totalElements != target.totalElements ||
              page.totalPages != target.totalPages)) {
        throw _changed();
      }
      final previous = target.items;
      final ids = previous.map((item) => item.id).toSet();
      var lastVersion = previous.lastOrNull?.versionNumber;
      for (final item in page.items) {
        if (!ids.add(item.id) ||
            (lastVersion != null && item.versionNumber >= lastVersion)) {
          throw _changed();
        }
        lastVersion = item.versionNumber;
      }
      final remaining = page.totalElements - page.page * page.size;
      final expected = remaining < page.size ? remaining : page.size;
      if (expected < 0 || page.items.length != expected) throw _changed();
      if (!target.accept(page, request: token, identity: (item) => item.id)) {
        return;
      }
      _pages = target;
      _selectionTag = current?.etag;
      _dirty = false;
      phase = items.isEmpty
          ? SummaryHistoryPhase.empty
          : SummaryHistoryPhase.available;
      failure = null;
      notifyListeners();
    } catch (error) {
      if (!_owns(generation, readEpoch)) return;
      if (error is ApiFailure && {401, 403, 404}.contains(error.status)) {
        _recoveringRead = true;
        _clear(SummaryHistoryPhase.forbidden);
        try {
          await workspace.handleProtectedReadFailure(error, epoch: readEpoch);
        } finally {
          _recoveringRead = false;
        }
        if (!_disposed && workspace.canReadHistory) {
          phase = SummaryHistoryPhase.failed;
          failure = error;
          notifyListeners();
        }
        return;
      }
      if (error is ApiFailure && error.code == 'RESULTS_HISTORY_CHANGED') {
        _dirty = true;
      }
      phase = SummaryHistoryPhase.failed;
      failure = error;
      notifyListeners();
    }
  }

  static ApiFailure _changed() => const ApiFailure(
    409,
    'RESULTS_HISTORY_CHANGED',
    'Lịch sử phiên bản đã thay đổi. Vui lòng tải lại.',
  );

  void _workspaceChanged() {
    if (_disposed) return;
    if (!workspace.canReadHistory) {
      _clear(SummaryHistoryPhase.forbidden);
      return;
    }
    if (_recoveringRead) return;
    final tag = workspace.currentSummaryForHistory?.etag;
    final previous = _observedTag ?? _selectionTag;
    final changed = tag != null && previous != null && tag != previous;
    _observedTag = tag;
    if (changed) _markDirty();
    if (_active && _dirty && _request == null &&
        (changed || phase == SummaryHistoryPhase.forbidden)) {
      unawaited(load(refresh: true));
    }
  }

  void _invalidationChanged() {
    if (_disposed) return;
    final signal = workspace.invalidation;
    if (signal.sessionScope != workspace.sessionScope ||
        signal.meetingId?.toLowerCase() != workspace.meetingId.toLowerCase() ||
        !signal.resources.contains(ResultsResourceKind.summaryVersions)) {
      return;
    }
    _markDirty();
    if (_active && !_recoveringRead && _request == null) {
      unawaited(load(refresh: true));
    }
  }

  void _markDirty() {
    _generation++;
    _dirty = true;
  }

  void _clear(SummaryHistoryPhase next) {
    if (_disposed) return;
    if (phase == next && _pages.items.isEmpty) return;
    _markDirty();
    _pages = PageWindow<SummaryVersion>();
    _selectionTag = null;
    _observedTag = null;
    _request = null;
    phase = next;
    failure = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _pages = PageWindow<SummaryVersion>();
    workspace.removeListener(_workspaceChanged);
    workspace.invalidation.removeListener(_invalidationChanged);
    super.dispose();
  }
}
