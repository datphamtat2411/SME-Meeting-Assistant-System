import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

class AssistantMeetingPicker extends StatefulWidget {
  const AssistantMeetingPicker({super.key, required this.dependencies});

  final AppDependencies dependencies;

  @override
  State<AssistantMeetingPicker> createState() => _AssistantMeetingPickerState();
}

class _AssistantMeetingPickerState extends State<AssistantMeetingPicker> {
  late final MeetingDiscoveryController _controller;
  final _search = TextEditingController();
  MeetingRelationship _relationship = MeetingRelationship.participant;

  @override
  void initState() {
    super.initState();
    _controller = MeetingDiscoveryController(
      repository: widget.dependencies.meetings,
      invalidation: widget.dependencies.meetingInvalidation,
    );
    unawaited(_searchMeetings());
  }

  Future<void> _searchMeetings() =>
      _controller.applyQuery(search: _search.text, relationship: _relationship);

  @override
  void dispose() {
    _controller.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Chọn cuộc họp')),
    body: SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Mỗi hội thoại chỉ truy vấn một cuộc họp. '
                  'Quyền đọc nội dung được máy chủ kiểm tra.',
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _search,
                  maxLength: 200,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _searchMeetings(),
                  decoration: InputDecoration(
                    hintText: 'Tìm tên cuộc họp',
                    counterText: '',
                    suffixIcon: IconButton(
                      tooltip: 'Tìm kiếm',
                      icon: const Icon(Icons.search),
                      onPressed: _searchMeetings,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                SegmentedButton<MeetingRelationship>(
                  segments: const [
                    ButtonSegment(
                      value: MeetingRelationship.participant,
                      label: Text('Tham gia'),
                    ),
                    ButtonSegment(
                      value: MeetingRelationship.organizer,
                      label: Text('Tổ chức'),
                    ),
                  ],
                  selected: {_relationship},
                  onSelectionChanged: (values) {
                    setState(() => _relationship = values.single);
                    unawaited(_searchMeetings());
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: AnimatedBuilder(
              animation: _controller,
              builder: (context, _) {
                final state = _controller.state;
                if (state.initialLoading && state.items.isEmpty) {
                  return const Center(child: CircularProgressIndicator());
                }
                return RefreshIndicator(
                  onRefresh: _controller.refresh,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    children: [
                      if (state.loadingFailure != null ||
                          state.refreshFailure != null ||
                          state.collectionChanged)
                        MessagePanel(
                          title: 'Cần đồng bộ danh sách',
                          onRetry: _controller.refresh,
                        )
                      else if (state.isConfirmedEmpty)
                        const MessagePanel(
                          title: 'Không tìm thấy cuộc họp',
                          description: 'Thử đổi từ khóa hoặc nhóm cuộc họp.',
                        ),
                      for (final item in state.items)
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.event_note_outlined),
                            title: Text(item.meeting.title),
                            subtitle: Text(
                              item.meeting.scheduledStartAt == null
                                  ? 'Chưa lên lịch'
                                  : DateFormat('dd/MM/yyyy · HH:mm').format(
                                      item.meeting.scheduledStartAt!.toLocal(),
                                    ),
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap:
                                state.collectionChanged ||
                                    state.refreshing ||
                                    state.refreshFailure != null
                                ? null
                                : () => Navigator.pop(context, item.meeting),
                          ),
                        ),
                      if (state.hasMore && !state.collectionChanged)
                        TextButton(
                          onPressed: state.loadingMore
                              ? null
                              : _controller.loadMore,
                          child: Text(
                            state.loadingMore ? 'Đang tải…' : 'Xem thêm',
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    ),
  );
}
