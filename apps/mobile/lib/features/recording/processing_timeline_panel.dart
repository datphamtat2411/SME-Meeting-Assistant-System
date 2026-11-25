import 'dart:async';

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
  late Future<List<ProcessingJobRecord>> future;
  bool retrying = false;
  late final AuthenticatedSessionScope sessionScope;
  MeetingCapabilities? _capabilities;
  ProcessingObservation? observation;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    sessionScope = widget.api.requireAuthenticatedSessionScope();
    _capabilities = widget.capabilities;
    widget.processingManager.addListener(_managerChanged);
    _managerChanged();
    if (_allows(MeetingOperation.readMedia)) {
      observation = widget.processingManager.startObserving(
        widget.meetingId,
        scope: sessionScope,
      );
    }
  }

  @override
  void didUpdateWidget(covariant ProcessingTimelinePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    final hadReadAccess =
        oldWidget.capabilities?.allows(MeetingOperation.readMedia) == true;
    _capabilities = widget.capabilities;
    final hasReadAccess = _allows(MeetingOperation.readMedia);
    if (!hadReadAccess && hasReadAccess && observation == null) {
      observation = widget.processingManager.startObserving(
        widget.meetingId,
        scope: sessionScope,
      );
    } else if (hadReadAccess && !hasReadAccess) {
      observation?.dispose();
      observation = null;
    }
  }

  bool _allows(MeetingOperation operation) =>
      _capabilities?.allows(operation) == true;

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
      setState(
        () => future = Future<List<ProcessingJobRecord>>.value(const []),
      );
      return;
    }
    if (!widget.api.isCurrentAuthenticatedSession(sessionScope)) return;
    unawaited(
      widget.processingManager.refresh(
        widget.meetingId,
        scope: sessionScope,
        explicit: true,
      ),
    );
    _managerChanged();
  }

  void _managerChanged() {
    if (!mounted) return;
    final state = widget.processingManager.stateFor(widget.meetingId);
    setState(
      () => future = Future<List<ProcessingJobRecord>>.value(
        state?.jobs ?? const <ProcessingJobRecord>[],
      ),
    );
  }

  Future<void> retry(ProcessingJobRecord candidate) async {
    if (retrying || !_allows(MeetingOperation.retryProcessing)) return;
    setState(() => retrying = true);
    try {
      await widget.processingManager.retryJob(
        job: candidate,
        scope: sessionScope,
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
  Widget build(BuildContext context) => AsyncContent<List<ProcessingJobRecord>>(
    future: future,
    retry: reload,
    builder: (jobs) => RefreshIndicator(
      onRefresh: () async {
        reload();
        await future;
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
    ),
  );
}
