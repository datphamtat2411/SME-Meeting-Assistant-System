import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'processing_repository.dart';
import 'processing_manager.dart';
import '../meetings/meeting_foundation.dart';

class ProcessingTimelinePanel extends StatefulWidget {
  const ProcessingTimelinePanel({
    super.key,
    required this.api,
    required this.meetingId,
    this.processingRepository,
    this.processingManager,
    this.localMedia,
    this.canRetry = true,
    this.capabilities,
  });
  final ApiClient api;
  final String meetingId;
  final ProcessingRepository? processingRepository;
  final ProcessingManager? processingManager;
  final LocalMediaRepository? localMedia;
  final bool canRetry;
  final MeetingCapabilities? capabilities;
  @override
  State<ProcessingTimelinePanel> createState() =>
      _ProcessingTimelinePanelState();
}

class _ProcessingTimelinePanelState extends State<ProcessingTimelinePanel>
    with WidgetsBindingObserver {
  late final ProcessingRepository processingRepository;
  late Future<List<ProcessingJobRecord>> future;
  Timer? timer;
  bool retrying = false;
  late final AuthenticatedSessionScope sessionScope;
  MeetingCapabilities? _capabilities;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    processingRepository =
        widget.processingRepository ?? ProcessingRepository(api: widget.api);
    sessionScope = widget.api.requireAuthenticatedSessionScope();
    _capabilities = widget.capabilities;
    if (widget.processingManager != null) {
      widget.processingManager!.addListener(_managerChanged);
      _managerChanged();
      widget.processingManager!.startObserving(
        widget.meetingId,
        scope: sessionScope,
      );
    } else {
      reload();
      timer = Timer.periodic(const Duration(seconds: 12), (_) => reload());
    }
  }

  @override
  void didUpdateWidget(covariant ProcessingTimelinePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _capabilities = widget.capabilities;
  }

  bool _allows(MeetingOperation operation) =>
      _capabilities?.allows(operation) == true;

  void _requireCapability(MeetingOperation operation) {
    if (!_allows(operation)) {
      throw const ApiFailure(
        403,
        'MEDIA_CAPABILITY_REQUIRED',
        'Bạn không có quyền thực hiện thao tác xử lý này.',
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (widget.processingManager != null) return;
    if (state == AppLifecycleState.resumed) reload();
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive)
      timer?.cancel();
    if (state == AppLifecycleState.resumed) {
      timer?.cancel();
      timer = Timer.periodic(const Duration(seconds: 12), (_) => reload());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    timer?.cancel();
    if (widget.processingManager != null) {
      widget.processingManager!
        ..removeListener(_managerChanged)
        ..stopObserving(widget.meetingId);
    }
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
    final manager = widget.processingManager;
    if (manager != null) {
      unawaited(
        manager.refresh(widget.meetingId, scope: sessionScope, explicit: true),
      );
      _managerChanged();
      return;
    }
    setState(() {
      future = processingRepository.list(
        widget.meetingId,
        sessionScope: sessionScope,
      );
    });
  }

  void _managerChanged() {
    if (!mounted) return;
    final manager = widget.processingManager;
    if (manager == null) return;
    final state = manager.stateFor(widget.meetingId);
    setState(
      () => future = Future<List<ProcessingJobRecord>>.value(
        state?.jobs ?? const <ProcessingJobRecord>[],
      ),
    );
  }

  Future<void> retry(ProcessingJobRecord candidate) async {
    if (retrying || !_allows(MeetingOperation.retryProcessing)) return;
    setState(() => retrying = true);
    final manager = widget.processingManager;
    if (manager != null) {
      try {
        await manager.retryJob(
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
      return;
    }
    ProcessingOperation? operation;
    final scope = sessionScope;
    try {
      _requireCapability(MeetingOperation.retryProcessing);
      widget.api.requireCurrentAuthenticatedSession(scope);
      final rand = Random.secure();
      final key = List<int>.generate(
        16,
        (_) => rand.nextInt(256),
      ).map((v) => v.toRadixString(16).padLeft(2, '0')).join();
      final localMedia = widget.localMedia;
      if (localMedia != null) {
        operation = await localMedia.beginProcessingOperation(
          scope: scope,
          meetingId: candidate.meetingId,
          idempotencyKey: key,
          operationType: ProcessingOperationType.retry,
          targetJobId: candidate.id,
        );
      }
      _requireCapability(MeetingOperation.retryProcessing);
      widget.api.requireCurrentAuthenticatedSession(scope);
      final accepted = await processingRepository.retry(
        candidate.id,
        idempotencyKey: key,
        sessionScope: scope,
      );
      if (operation != null && localMedia != null) {
        await localMedia.updateProcessingOperation(
          operation,
          scope: scope,
          checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
          resultingJobId: accepted.id,
        );
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(scope)) {
        showSuccess(context, 'Đã tiếp nhận yêu cầu thử lại.');
        reload();
      }
    } catch (error) {
      final localMedia = widget.localMedia;
      final activeScope = scope;
      if (localMedia != null &&
          widget.api.isCurrentAuthenticatedSession(activeScope) &&
          operation != null) {
        final failure = error is ApiFailure ? error : null;
        final failedOperation = operation;
        try {
          await localMedia.updateProcessingOperation(
            failedOperation,
            scope: activeScope,
            attemptCount: failedOperation.attemptCount + 1,
            attemptOutcome: _operationOutcome(failure),
            recoveryRequired:
                failure == null ||
                failure.remoteOutcomeAmbiguous ||
                failure.isTransportFailure,
            failureCode: failure?.code ?? 'PROCESSING_RETRY_FAILED',
            failureStatus: failure?.status,
            failureMessage: failure?.message,
          );
        } catch (_) {}
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(activeScope)) {
        showFailure(context, error);
      }
    } finally {
      if (mounted) setState(() => retrying = false);
    }
  }

  OperationAttemptOutcome _operationOutcome(ApiFailure? failure) {
    if (failure == null ||
        failure.remoteOutcomeAmbiguous ||
        failure.isTransportFailure) {
      return OperationAttemptOutcome.uncertain;
    }
    if (failure.status >= 400 && failure.status < 500) {
      return OperationAttemptOutcome.rejected;
    }
    return OperationAttemptOutcome.failed;
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
