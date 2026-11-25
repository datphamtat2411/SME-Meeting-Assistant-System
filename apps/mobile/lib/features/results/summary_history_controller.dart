import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../../core/paged_collection.dart';
import 'results_invalidation.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

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
class SummaryHistoryController extends ChangeNotifier {
  SummaryHistoryController(this.workspace) {
    workspace.addListener(_workspaceChanged);
    workspace.invalidation.addListener(_invalidationChanged);
  }

  final ResultsWorkspaceController workspace;
  final PageWindow<SummaryVersion> _pages = PageWindow<SummaryVersion>();
  Future<void>? _request;
  int _generation = 0;
  bool _started = false;
  bool _disposed = false;
  bool _recoveringRead = false;
  SummaryHistoryPhase phase = SummaryHistoryPhase.uninitialized;
  Object? failure;

  List<SummaryVersion> get items => _pages.items;
  bool get hasMore => _pages.hasMore;
  bool get isLoading =>
      phase == SummaryHistoryPhase.loading ||
      phase == SummaryHistoryPhase.refreshing;

  Future<void> load({bool refresh = false}) {
    if (_disposed ||
        !workspace.ownsSession ||
        !workspace.capabilities.canRead) {
      _clear(SummaryHistoryPhase.forbidden);
      return Future<void>.value();
    }
    _started = true;
    if (refresh) {
      _generation++;
      _pages.reset();
      _request = null;
      phase = SummaryHistoryPhase.refreshing;
      failure = null;
      notifyListeners();
    } else if (_request != null || !_pages.hasMore) {
      return _request ?? Future<void>.value();
    } else if (phase == SummaryHistoryPhase.uninitialized ||
        phase == SummaryHistoryPhase.failed) {
      phase = SummaryHistoryPhase.loading;
      failure = null;
      notifyListeners();
    }

    final token = _pages.beginRequest();
    final requestGeneration = _generation;
    final operation = _loadPage(token, requestGeneration, workspace.readEpoch);
    _request = operation;
    unawaited(
      operation.whenComplete(() {
        if (identical(_request, operation)) _request = null;
      }),
    );
    return operation;
  }

  Future<void> loadMore() => load();

  Future<void> _loadPage(
    PageRequestToken token,
    int generation,
    int readEpoch,
  ) async {
    try {
      final page = await workspace.repository.summaryVersions(
        sessionScope: workspace.sessionScope,
        meetingId: workspace.meetingId,
        page: token.page,
        size: 20,
      );
      if (generation != _generation ||
          _disposed ||
          !workspace.ownsRead(readEpoch)) {
        return;
      }
      final accepted = _pages.accept(
        page,
        request: token,
        identity: (item) => item.id,
      );
      if (!accepted) return;
      phase = _pages.items.isEmpty
          ? SummaryHistoryPhase.empty
          : SummaryHistoryPhase.available;
      failure = null;
      notifyListeners();
    } catch (error) {
      if (generation != _generation ||
          _disposed ||
          !workspace.ownsRead(readEpoch)) {
        return;
      }
      if (error is ApiFailure && {401, 403, 404}.contains(error.status)) {
        _recoveringRead = true;
        _clear(SummaryHistoryPhase.forbidden);
        try {
          await workspace.handleProtectedReadFailure(error, epoch: readEpoch);
        } finally {
          _recoveringRead = false;
        }
        if (!_disposed && workspace.capabilities.canRead) {
          phase = SummaryHistoryPhase.failed;
          failure = error;
          notifyListeners();
        }
        return;
      }
      phase = SummaryHistoryPhase.failed;
      failure = error;
      notifyListeners();
    }
  }

  void _workspaceChanged() {
    if (_disposed) return;
    if (!workspace.ownsSession || !workspace.capabilities.canRead) {
      _clear(SummaryHistoryPhase.forbidden);
      return;
    }
    if (_recoveringRead) return;
    if (_started && phase == SummaryHistoryPhase.forbidden) {
      unawaited(load(refresh: true));
      return;
    }
    if (_started) notifyListeners();
  }

  void _invalidationChanged() {
    if (_disposed) return;
    final signal = workspace.invalidation;
    if (signal.meetingId?.toLowerCase() != workspace.meetingId.toLowerCase() ||
        !signal.resources.contains(ResultsResourceKind.summaryVersions)) {
      return;
    }
    if (_started && !_recoveringRead) unawaited(load(refresh: true));
  }

  void _clear(SummaryHistoryPhase next) {
    if (_disposed) return;
    if (phase == next && _pages.items.isEmpty) return;
    _generation++;
    _pages.reset();
    _request = null;
    phase = next;
    failure = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    workspace.removeListener(_workspaceChanged);
    workspace.invalidation.removeListener(_invalidationChanged);
    super.dispose();
  }
}
