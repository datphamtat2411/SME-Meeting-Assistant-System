import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';
import 'media_contracts.dart';
import 'processing_manager.dart';
import '../meetings/meeting_foundation.dart';

class ProcessingTimelinePanel extends StatefulWidget {
  const ProcessingTimelinePanel({
    super.key,
    required this.api,
    required this.meetingId,
    required this.processingManager,
    this.canRetry = true,
    this.capabilities,
  });
  final ApiClient api;
  final String meetingId;
  final ProcessingManager processingManager;
  final bool canRetry;
  final MeetingCapabilities? capabilities;
  @override
  State<ProcessingTimelinePanel> createState() =>
      _ProcessingTimelinePanelState();
}

class _ProcessingTimelinePanelState extends State<ProcessingTimelinePanel>
    with WidgetsBindingObserver {
  List<ProcessingJobRecord> jobs = const <ProcessingJobRecord>[];
  Object? failure;
  bool loading = true;
  bool retrying = false;
  AuthenticatedSessionScope? sessionScope;
  MeetingCapabilities? _capabilities;
  ProcessingObservation? observation;
  bool _initializing = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    sessionScope = widget.api.requireAuthenticatedSessionScope();
    _capabilities = widget.capabilities;
    widget.processingManager.addListener(_managerChanged);
    _managerChanged(update: false);
    _startObservation();
    _initializing = false;
    _managerChanged(update: false);
    if (!_allows(MeetingOperation.readMedia)) loading = false;
  }

  @override
  void didUpdateWidget(covariant ProcessingTimelinePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextScope = widget.api.authenticatedSessionScope;
    final meetingChanged = oldWidget.meetingId != widget.meetingId;
    final sessionChanged = nextScope != sessionScope;
    final hadReadAccess =
        oldWidget.capabilities?.allows(MeetingOperation.readMedia) == true;
    _capabilities = widget.capabilities;
    if (meetingChanged || sessionChanged) {
      observation?.dispose();
      observation = null;
      sessionScope = nextScope;
      jobs = const <ProcessingJobRecord>[];
      failure = null;
      loading = true;
      if (_allows(MeetingOperation.readMedia)) {
        _startObservation();
      }
      _managerChanged(update: false);
      if (!_allows(MeetingOperation.readMedia)) loading = false;
      return;
    }
    final hasReadAccess = _allows(MeetingOperation.readMedia);
    if (!hadReadAccess && hasReadAccess && observation == null) {
      _startObservation();
    } else if (hadReadAccess && !hasReadAccess) {
      observation?.dispose();
      observation = null;
      jobs = const <ProcessingJobRecord>[];
      failure = null;
      loading = false;
    }
  }

  bool _allows(MeetingOperation operation) =>
      sessionScope != null &&
      widget.api.isCurrentAuthenticatedSession(sessionScope!) &&
      _capabilities?.allows(operation) == true;

  void _startObservation() {
    final scope = sessionScope;
    if (scope == null || !_allows(MeetingOperation.readMedia)) return;
    try {
      observation = widget.processingManager.startObserving(
        widget.meetingId,
        scope: scope,
      );
    } catch (error) {
      if (mounted) {
        setState(() {
          failure = error;
          loading = false;
        });
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // ProcessingManager owns the foreground/background polling lifecycle.
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    observation?.dispose();
    widget.processingManager.removeListener(_managerChanged);
    super.dispose();
  }

  void reload() {
    if (!mounted) return;
    if (!_allows(MeetingOperation.readMedia)) {
      setState(() {
        jobs = const <ProcessingJobRecord>[];
        failure = null;
        loading = false;
      });
      return;
    }
    final scope = sessionScope;
    if (scope == null || !widget.api.isCurrentAuthenticatedSession(scope)) {
      return;
    }
    unawaited(
      widget.processingManager.refresh(
        widget.meetingId,
        scope: scope,
        explicit: true,
      ),
    );
    _managerChanged();
  }

  void _managerChanged({bool update = true}) {
    if (!mounted) return;
    final scope = sessionScope;
    final state = scope == null
        ? null
        : widget.processingManager.stateFor(widget.meetingId, scope: scope);
    final nextJobs = List<ProcessingJobRecord>.unmodifiable(
      state?.jobs ?? const <ProcessingJobRecord>[],
    );
    final nextFailure = state?.failure;
    final nextLoading = state == null;
    if (listEquals(jobs, nextJobs) &&
        failure == nextFailure &&
        loading == nextLoading) {
      return;
    }
    void apply() {
      jobs = nextJobs;
      failure = nextFailure;
      loading = nextLoading;
    }

    if (!update || _initializing) {
      apply();
      return;
    }
    setState(apply);
  }

  Future<void> retry(ProcessingJobRecord candidate) async {
    final scope = sessionScope;
    if (retrying ||
        scope == null ||
        !_allows(MeetingOperation.retryProcessing)) {
      return;
    }
    setState(() => retrying = true);
    try {
      await widget.processingManager.retryJob(
        job: candidate,
        scope: scope,
        capabilities: widget.capabilities,
      );
      if (mounted) showSuccess(context, 'Đã tiếp nhận yêu cầu thử lại.');
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(36),
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (failure != null) {
      return MessagePanel(
        icon: Icons.cloud_off_outlined,
        title: 'Không thể tải dữ liệu',
        description: failure is ApiFailure
            ? (failure as ApiFailure).message
            : 'Đã xảy ra lỗi không mong muốn.',
        onRetry: reload,
      );
    }
    return RefreshIndicator(
      onRefresh: () async {
        reload();
        final scope = sessionScope;
        if (scope != null && _allows(MeetingOperation.readMedia)) {
          await widget.processingManager.refresh(
            widget.meetingId,
            scope: scope,
            explicit: true,
          );
        }
      },
      child: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const SectionHeading(
            'Tiến trình xử lý AI',
            subtitle: 'Trạng thái từ Core API, tự làm mới khi màn hình mở.',
          ),
          if (jobs.isEmpty) const MessagePanel(title: 'Chưa có tác vụ xử lý'),
          ...jobs.map((item) {
            return ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.auto_awesome, color: Palette.blue),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          item.currentStage ?? 'AI processing',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                      StatePill(item.status.wireValue),
                    ],
                  ),
                  const SizedBox(height: 9),
                  Text(
                    'Job ID: ' + item.id,
                    style: const TextStyle(fontSize: 11, color: Palette.muted),
                  ),
                  ...item.stageRuns.map(
                    (step) => Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.chevron_right,
                            size: 17,
                            color: Palette.muted,
                          ),
                          Expanded(
                            child: Text(
                              step.stageCode + ' · ' + step.status.wireValue,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (item.warningSummary != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        item.warningSummary!,
                        style: const TextStyle(color: Palette.amber),
                      ),
                    ),
                  if (item.errorSummary != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        item.errorSummary!,
                        style: const TextStyle(color: Palette.red),
                      ),
                    ),
                  if (item.retryable)
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed:
                            !widget.canRetry ||
                                !_allows(MeetingOperation.retryProcessing) ||
                                retrying
                            ? null
                            : () => retry(item),
                        child: const Text('Thử lại xử lý'),
                      ),
                    ),
                ],
              ),
            );
          }),
        ],
      ),
    );
  }
}
