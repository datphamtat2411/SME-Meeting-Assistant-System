import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class ProcessingTimelinePanel extends StatefulWidget {
  const ProcessingTimelinePanel({
    super.key,
    required this.api,
    required this.meetingId,
  });
  final ApiClient api;
  final String meetingId;
  @override
  State<ProcessingTimelinePanel> createState() =>
      _ProcessingTimelinePanelState();
}

class _ProcessingTimelinePanelState extends State<ProcessingTimelinePanel>
    with WidgetsBindingObserver {
  late Future<List<ProcessingJob>> future;
  Timer? timer;
  bool retrying = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    reload();
    timer = Timer.periodic(const Duration(seconds: 12), (_) => reload());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
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
    super.dispose();
  }

  void reload() {
    if (!mounted) return;
    setState(() {
      future = widget.api
          .get('/meetings/' + widget.meetingId + '/processing-jobs')
          .then(
            (response) => response
                .objectArrayData()
                .map((raw) => ProcessingJob.fromJson(raw, response: response))
                .toList(),
          );
    });
  }

  Future<void> retry(String id) async {
    if (retrying) return;
    setState(() => retrying = true);
    try {
      final rand = Random.secure();
      final key = List<int>.generate(
        16,
        (_) => rand.nextInt(256),
      ).map((v) => v.toRadixString(16).padLeft(2, '0')).join();
      await widget.api.post(
        '/processing-jobs/' + id + '/retry',
        {},
        headers: {'Idempotency-Key': key},
      );
      if (mounted) {
        showSuccess(context, 'Đã tiếp nhận yêu cầu thử lại.');
        reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) => AsyncContent<List<ProcessingJob>>(
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
                      StatePill(item.status),
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
                              step.stageCode + ' · ' + step.status,
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
                        onPressed: retrying ? null : () => retry(item.id),
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
