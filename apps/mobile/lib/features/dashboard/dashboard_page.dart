import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import '../action_items/action_item_collection.dart';
import '../action_items/action_item_invalidation.dart';
import 'dashboard_controller.dart';

class DashboardPage extends StatefulWidget {
  final ApiClient api;
  final VoidCallback openMeetings;
  final ValueChanged<MyWorkDestination> openActions;
  final ActionItemInvalidationSignal invalidation;
  final bool active;
  const DashboardPage({
    super.key,
    required this.api,
    required this.openMeetings,
    required this.openActions,
    required this.invalidation,
    this.active = true,
  });

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  late final DashboardController _controller;

  @override
  void initState() {
    super.initState();
    _controller = DashboardController(
      api: widget.api,
      invalidation: widget.invalidation,
      active: widget.active,
    );
    _controller.addListener(_changed);
    unawaited(_controller.refresh());
  }

  @override
  void didUpdateWidget(covariant DashboardPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.setActive(widget.active);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller.removeListener(_changed);
    _controller.dispose();
    super.dispose();
  }

  Widget _content(Widget Function(Map<String, dynamic>) builder) {
    final data = _controller.data;
    if (!_controller.current) {
      return const MessagePanel(title: 'Phiên đăng nhập đã thay đổi');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_controller.loading) const LinearProgressIndicator(),
        if (_controller.failure != null)
          MessagePanel(
            title: 'Không thể cập nhật tổng quan',
            description: 'Vui lòng tải lại dữ liệu từ máy chủ.',
            onRetry: _controller.refresh,
          ),
        if (data != null) builder(data),
      ],
    );
  }

  Widget metric(
    String label,
    String value,
    IconData icon,
    Color tone, {
    MyWorkDestination? destination,
  }) => ContentCard(
    child: InkWell(
      onTap: destination == null ? null : () => widget.openActions(destination),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: tone.withValues(alpha: 0.1),
            child: Icon(icon, color: tone),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  value,
                  style: const TextStyle(
                    fontSize: 25,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                Text(
                  label,
                  style: const TextStyle(color: Palette.muted, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: _controller.refresh,
    child: ListView(
      padding: const EdgeInsets.all(18),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SectionHeading(
          'Xin chào, ' +
              (widget.api.displayName.isEmpty
                  ? 'đồng nghiệp'
                  : widget.api.displayName),
          subtitle: 'Lịch trình và công việc của bạn',
          trailing: IconButton(
            onPressed: _controller.refresh,
            icon: const Icon(Icons.refresh),
          ),
        ),
        _content((data) {
          final counts = objectOf(data['meetingCountsByState']);
          final tasks = objectOf(data['assignedActionItems']);
          final meetings = objectsOf(data['upcomingMeetings']);
          final recent = objectsOf(data['recentMeetings']);
          final upcomingCount = (counts['SCHEDULED'] as num?)?.toInt() ?? 0;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              LayoutBuilder(
                builder: (context, constraints) {
                  final width = (constraints.maxWidth - 10) / 2;
                  return Wrap(
                    spacing: 10,
                    runSpacing: 0,
                    children: [
                      SizedBox(
                        width: width,
                        child: metric(
                          'Đã lên lịch',
                          upcomingCount.toString(),
                          Icons.calendar_month,
                          Palette.blue,
                        ),
                      ),
                      SizedBox(
                        width: width,
                        child: metric(
                          'Cần thực hiện',
                          textValue(tasks['open']),
                          Icons.checklist,
                          Palette.amber,
                          destination: MyWorkDestination.open,
                        ),
                      ),
                      SizedBox(
                        width: width,
                        child: metric(
                          'Đang thực hiện',
                          textValue(tasks['inProgress']),
                          Icons.play_circle_outline,
                          Palette.blue,
                          destination: MyWorkDestination.inProgress,
                        ),
                      ),
                      SizedBox(
                        width: width,
                        child: metric(
                          'Quá hạn',
                          textValue(tasks['overdue']),
                          Icons.warning_amber,
                          Palette.red,
                          destination: MyWorkDestination.overdue,
                        ),
                      ),
                      SizedBox(
                        width: width,
                        child: metric(
                          'Đã hoàn thành',
                          textValue(tasks['done']),
                          Icons.task_alt,
                          Palette.green,
                          destination: MyWorkDestination.done,
                        ),
                      ),
                    ],
                  );
                },
              ),
              SectionHeading(
                'Cuộc họp sắp tới',
                trailing: TextButton(
                  onPressed: widget.openMeetings,
                  child: const Text('Xem tất cả'),
                ),
              ),
              if (meetings.isEmpty)
                const MessagePanel(title: 'Không có cuộc họp sắp tới')
              else
                ...meetings
                    .take(5)
                    .map(
                      (m) => ContentCard(
                        child: Row(
                          children: [
                            const Icon(
                              Icons.video_camera_front_outlined,
                              color: Palette.blue,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    textValue(m['title']),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    dateLabel(m['scheduledStartAt']),
                                    style: const TextStyle(
                                      color: Palette.muted,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            StatePill(textValue(m['status'])),
                          ],
                        ),
                      ),
                    ),
              SectionHeading(
                'Gần đây',
                trailing: TextButton(
                  onPressed: () => widget.openActions(MyWorkDestination.all),
                  child: const Text('Việc cần làm'),
                ),
              ),
              if (recent.isEmpty)
                const MessagePanel(title: 'Chưa có cuộc họp gần đây')
              else
                ...recent
                    .take(4)
                    .map(
                      (m) => ContentCard(
                        child: Row(
                          children: [
                            const Icon(
                              Icons.description_outlined,
                              color: Palette.muted,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                textValue(m['title']),
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            StatePill(textValue(m['status'])),
                          ],
                        ),
                      ),
                    ),
            ],
          );
        }),
      ],
    ),
  );
}
