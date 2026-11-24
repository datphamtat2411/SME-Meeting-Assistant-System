import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_participants.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_edit_sheet.dart';
import 'package:sme_meeting_assistant/features/recording/recording_page.dart';
import 'package:sme_meeting_assistant/features/recording/processing_timeline_panel.dart';
import 'package:sme_meeting_assistant/features/results/results_panel.dart';

class MeetingDetailPage extends StatefulWidget {
  const MeetingDetailPage({
    super.key,
    required this.dependencies,
    required this.meetingId,
  });

  final AppDependencies dependencies;
  final String meetingId;
  ApiClient get api => dependencies.api;

  @override
  State<MeetingDetailPage> createState() => _MeetingDetailPageState();
}

class _MeetingDetailPageState extends State<MeetingDetailPage> {
  late Future<MeetingSnapshot> _future;
  int _tab = 0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    setState(
      () => _future = widget.dependencies.meetings.detail(widget.meetingId),
    );
  }

  Future<void> _command(
    MeetingSnapshot snapshot,
    MeetingOperation operation,
  ) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      switch (operation) {
        case MeetingOperation.schedule:
          await widget.dependencies.meetings.schedule(
            snapshot,
            const MeetingScheduleInput(),
          );
        case MeetingOperation.start:
          await widget.dependencies.meetings.start(snapshot);
        case MeetingOperation.end:
          await widget.dependencies.meetings.end(snapshot);
        case MeetingOperation.cancel:
          await widget.dependencies.meetings.cancel(
            snapshot,
            const MeetingCancelInput(reason: 'Cancelled from mobile'),
          );
        case MeetingOperation.edit || MeetingOperation.manageParticipants:
          return;
      }
      if (mounted) {
        showSuccess(context, 'Đã cập nhật cuộc họp.');
        _reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmCancel(MeetingSnapshot snapshot) async {
    final proceed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Hủy cuộc họp?'),
        content: const Text(
          'Hành động sẽ giữ lịch sử nhưng giải phóng lịch phòng.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Quay lại'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Xác nhận hủy'),
          ),
        ],
      ),
    );
    if (proceed == true && mounted) {
      await _command(snapshot, MeetingOperation.cancel);
    }
  }

  Future<void> _edit(MeetingSnapshot snapshot) async {
    final updated = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => MeetingEditSheet(
        dependencies: widget.dependencies,
        snapshot: snapshot,
      ),
    );
    if (updated == true && mounted) _reload();
  }

  Widget _overview(MeetingSnapshot snapshot) {
    final meeting = snapshot.meeting;
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: widget.api.userId,
      meeting: meeting,
    );
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SectionHeading(meeting.title, subtitle: 'Thông tin cuộc họp'),
        if (capabilities.canEdit)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: OutlinedButton.icon(
              onPressed: _busy ? null : () => _edit(snapshot),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Chỉnh sửa cuộc họp'),
            ),
          ),
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              StatePill(meeting.status),
              const SizedBox(height: 16),
              Text(
                meeting.description == null || meeting.description!.isEmpty
                    ? 'Chưa có mô tả'
                    : meeting.description!,
              ),
              const Divider(height: 26),
              _line(
                Icons.event,
                'Bắt đầu',
                dateLabel(meeting.scheduledStartAt),
              ),
              _line(
                Icons.schedule,
                'Kết thúc',
                dateLabel(meeting.scheduledEndAt),
              ),
              _line(
                Icons.meeting_room_outlined,
                'Phòng họp',
                meeting.roomName ??
                    (meeting.roomId == null
                        ? 'Chưa chọn phòng'
                        : meeting.roomId!),
              ),
              _line(
                Icons.person_outline,
                'Người tổ chức',
                meeting.organizerName ?? meeting.organizerId,
              ),
            ],
          ),
        ),
        if (!_busy) ...[
          if (capabilities.canSchedule)
            FilledButton.icon(
              onPressed:
                  meeting.scheduledStartAt == null ||
                      meeting.scheduledEndAt == null
                  ? null
                  : () => _command(snapshot, MeetingOperation.schedule),
              icon: const Icon(Icons.event_available),
              label: Text(
                meeting.scheduledStartAt == null
                    ? 'Đặt thời gian trước khi xác nhận'
                    : 'Xác nhận lịch',
              ),
            ),
          if (capabilities.canStart) ...[
            FilledButton.icon(
              onPressed: () => _command(snapshot, MeetingOperation.start),
              icon: const Icon(Icons.play_arrow),
              label: const Text('Bắt đầu cuộc họp'),
            ),
            if (capabilities.canCancel) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => _confirmCancel(snapshot),
                icon: const Icon(Icons.cancel_outlined),
                label: const Text('Hủy cuộc họp'),
              ),
            ],
          ],
          if (capabilities.canEnd)
            FilledButton.icon(
              onPressed: () => _command(snapshot, MeetingOperation.end),
              icon: const Icon(Icons.stop),
              label: const Text('Kết thúc cuộc họp'),
            ),
        ] else
          const Center(child: CircularProgressIndicator()),
        const SizedBox(height: 16),
        const MessagePanel(
          icon: Icons.shield_outlined,
          title: 'Dữ liệu được phân quyền',
          description: 'Người tham gia, trạng thái xử lý và tài liệu được kiểm tra bởi Core API.',
        ),
      ],
    );
  }

  Widget _line(IconData icon, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 19, color: Palette.muted),
        const SizedBox(width: 10),
        SizedBox(
          width: 95,
          child: Text(label, style: const TextStyle(color: Palette.muted)),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Chi tiết cuộc họp'),
      actions: [
        IconButton(
          tooltip: 'Làm mới',
          onPressed: _reload,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: AsyncContent<MeetingSnapshot>(
      future: _future,
      retry: _reload,
      builder: (snapshot) => Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('Tổng quan')),
                ButtonSegment(value: 1, label: Text('Biên bản AI')),
                ButtonSegment(value: 2, label: Text('Ghi âm')),
                ButtonSegment(value: 3, label: Text('Thành viên')),
                ButtonSegment(value: 4, label: Text('Xử lý')),
              ],
              selected: {_tab},
              onSelectionChanged: (value) => setState(() => _tab = value.first),
            ),
          ),
          Expanded(
            child: switch (_tab) {
              0 => _overview(snapshot),
              1 => ResultsPanel(api: widget.api, meetingId: widget.meetingId),
              2 => RecordingPage(
                api: widget.api,
                meetingId: widget.meetingId,
                enabled: snapshot.meeting.status != 'CANCELLED',
              ),
              3 => MeetingParticipants(
                key: ValueKey('membership-${snapshot.etag}'),
                dependencies: widget.dependencies,
                snapshot: snapshot,
              ),
              _ => ProcessingTimelinePanel(
                api: widget.api,
                meetingId: snapshot.meeting.id,
              ),
            },
          ),
        ],
      ),
    ),
  );
}
