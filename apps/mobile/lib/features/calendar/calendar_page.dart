import 'dart:async';

import 'package:intl/intl.dart';
import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery_widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

class CalendarPage extends StatefulWidget {
  const CalendarPage({super.key, required this.dependencies});

  final AppDependencies dependencies;

  @override
  State<CalendarPage> createState() => _CalendarPageState();
}

class _CalendarPageState extends State<CalendarPage> {
  late final MeetingCalendarController _controller;
  DateTime? _selectedDate;

  @override
  void initState() {
    super.initState();
    _controller = MeetingCalendarController(
      repository: widget.dependencies.meetings,
      invalidation: widget.dependencies.meetingInvalidation,
    );
    unawaited(_controller.initialize());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _changeMonth(DateTime date) async {
    final changed =
        date.year != _controller.state.month.year ||
        date.month != _controller.state.month.month;
    if (changed) setState(() => _selectedDate = null);
    await _controller.setMonth(date);
  }

  Future<void> _openDetail(String meetingId) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => MeetingDetailPage(
          dependencies: widget.dependencies,
          meetingId: meetingId,
        ),
      ),
    );
    if (mounted) await _controller.refresh();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      final monthEntries = state.visibleEntries;
      final visible = _selectedDate == null
          ? monthEntries
          : monthEntries
                .where(
                  (entry) =>
                      meetingIntersectsLocalDay(entry.meeting, _selectedDate!),
                )
                .toList(growable: false);
      final range = _controller.range;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Lịch họp'),
          actions: [
            IconButton(
              tooltip: 'Làm mới lịch họp',
              onPressed: _controller.refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: RefreshIndicator(
          onRefresh: _controller.refresh,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
            children: [
              const SectionHeading(
                'Lịch trình',
                subtitle:
                    'Các cuộc họp dùng bộ lọc khoảng thời gian của Core API.',
              ),
              ContentCard(
                child: Column(
                  children: [
                    Row(
                      children: [
                        IconButton(
                          tooltip: 'Tháng trước',
                          onPressed: () => _changeMonth(
                            DateTime(state.month.year, state.month.month - 1),
                          ),
                          icon: const Icon(Icons.chevron_left),
                        ),
                        Expanded(
                          child: Text(
                            'Tháng ${state.month.month}/${state.month.year}',
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        IconButton(
                          tooltip: 'Tháng sau',
                          onPressed: () => _changeMonth(
                            DateTime(state.month.year, state.month.month + 1),
                          ),
                          icon: const Icon(Icons.chevron_right),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<MeetingRelationship?>(
                            key: ValueKey(
                              'calendar-relationship-${state.relationship?.wireValue ?? 'all'}',
                            ),
                            initialValue: state.relationship,
                            isExpanded: true,
                            decoration: const InputDecoration(
                              isDense: true,
                              labelText: 'Mối quan hệ',
                            ),
                            items: const [
                              DropdownMenuItem<MeetingRelationship?>(
                                value: null,
                                child: Text('Tất cả'),
                              ),
                              DropdownMenuItem<MeetingRelationship?>(
                                value: MeetingRelationship.organizer,
                                child: Text('Tổ chức'),
                              ),
                              DropdownMenuItem<MeetingRelationship?>(
                                value: MeetingRelationship.participant,
                                child: Text('Tham gia'),
                              ),
                            ],
                            onChanged: (value) => _controller.setFilters(
                              relationship: value,
                              status: state.status,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: DropdownButtonFormField<MeetingStatus?>(
                            key: ValueKey(
                              'calendar-status-${state.status?.wireValue ?? 'all'}',
                            ),
                            initialValue: state.status,
                            isExpanded: true,
                            decoration: const InputDecoration(
                              isDense: true,
                              labelText: 'Trạng thái',
                            ),
                            items: [
                              const DropdownMenuItem<MeetingStatus?>(
                                value: null,
                                child: Text('Trạng thái bất kỳ'),
                              ),
                              ...MeetingStatus.values.map(
                                (status) => DropdownMenuItem<MeetingStatus?>(
                                  value: status,
                                  child: Text(meetingStates[status.wireValue]!),
                                ),
                              ),
                            ],
                            onChanged: (value) => _controller.setFilters(
                              relationship: state.relationship,
                              status: value,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    CalendarDatePicker(
                      key: ValueKey(
                        'calendar-${state.month.year}-${state.month.month}',
                      ),
                      initialDate:
                          _selectedDate ??
                          DateTime(state.month.year, state.month.month),
                      firstDate: DateTime(2020),
                      lastDate: DateTime(2100),
                      onDisplayedMonthChanged: _changeMonth,
                      onDateChanged: (day) => setState(() {
                        _selectedDate = _sameDay(day, _selectedDate)
                            ? null
                            : day;
                      }),
                    ),
                    if (_selectedDate != null)
                      TextButton.icon(
                        onPressed: () => setState(() => _selectedDate = null),
                        icon: const Icon(Icons.clear),
                        label: const Text('Xem cả tháng'),
                      ),
                  ],
                ),
              ),
              if (state.isLoading || state.isRefreshing)
                const LinearProgressIndicator(),
              if (state.failure != null)
                MessagePanel(
                  icon: Icons.cloud_off_outlined,
                  title: 'Không thể tải toàn bộ dữ liệu lịch',
                  description: state.failure is ApiFailure
                      ? (state.failure! as ApiFailure).message
                      : 'Đã xảy ra lỗi khi tải lịch.',
                  onRetry: _controller.retry,
                ),
              if (state.collectionChanged)
                MessagePanel(
                  icon: Icons.sync_problem_outlined,
                  title: 'Lịch đã thay đổi trong lúc tải',
                  description: 'Đã dừng phân trang để tránh trộn các phiên bản khác nhau.',
                  onRetry: _controller.refresh,
                ),
              if (state.incomplete && state.failure == null)
                ContentCard(
                  child: Row(
                    children: [
                      const Icon(
                        Icons.warning_amber_outlined,
                        color: Palette.amber,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          state.hasMore
                              ? 'Đã tải ${state.loadedPageCount} trang. Tiếp tục để hoàn tất lịch trong giới hạn phân trang.'
                              : 'Dữ liệu lịch chưa hoàn chỉnh.',
                        ),
                      ),
                    ],
                  ),
                ),
              SectionHeading(
                _selectedDate == null
                    ? 'Cuộc họp trong tháng'
                    : 'Cuộc họp ngày ${DateFormat('dd/MM/yyyy').format(_selectedDate!)}',
                subtitle:
                    '${visible.length} cuộc họp · ${range.startLocal.toString().substring(0, 10)}',
              ),
              if (state.isConfirmedEmpty && state.failure == null)
                const MessagePanel(
                  icon: Icons.event_busy_outlined,
                  title: 'Chưa có cuộc họp',
                  description: 'Thử chọn ngày, tháng hoặc bộ lọc khác.',
                ),
              if (_selectedDate != null &&
                  visible.isEmpty &&
                  !state.isConfirmedEmpty &&
                  !state.isLoading &&
                  state.failure == null)
                const MessagePanel(
                  icon: Icons.event_busy_outlined,
                  title: 'Không có cuộc họp trong ngày đã chọn',
                  description: 'Các cuộc họp qua nửa đêm cũng được hiển thị theo phần thời gian giao nhau.',
                ),
              ...visible.map(
                (entry) => MeetingProjectionCard(
                  projection: entry,
                  onTap: () => _openDetail(entry.meeting.id),
                ),
              ),
              if (state.hasMore && !state.collectionChanged)
                OutlinedButton.icon(
                  onPressed: state.isLoading || state.isRefreshing
                      ? null
                      : _controller.continueLoading,
                  icon: const Icon(Icons.download_outlined),
                  label: const Text('Tải thêm trang lịch'),
                ),
            ],
          ),
        ),
      );
    },
  );

  bool _sameDay(DateTime first, DateTime? second) =>
      second != null &&
      first.year == second.year &&
      first.month == second.month &&
      first.day == second.day;
}
