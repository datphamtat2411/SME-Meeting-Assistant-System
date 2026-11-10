import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import '../meetings/meeting_detail_page.dart';

/// A calendar projection over canonical meetings, never a local schedule store.
class CalendarPage extends StatefulWidget {
  final ApiClient api;
  const CalendarPage({super.key, required this.api});

  @override
  State<CalendarPage> createState() => _CalendarPageState();
}

class _CalendarFeed {
  const _CalendarFeed(this.items, this.hasMore);
  final List<Meeting> items;
  final bool hasMore;
}

class _CalendarPageState extends State<CalendarPage> {
  late DateTime month;
  DateTime? selectedDate;
  bool myMeetings = true;
  late Future<_CalendarFeed> future;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    month = DateTime(now.year, now.month);
    reload();
  }

  Future<_CalendarFeed> _fetchForRelationship(String? relationship) async {
    final start = DateTime(month.year, month.month).toUtc().toIso8601String();
    final end = DateTime(month.year, month.month + 1).toUtc().toIso8601String();
    final all = <Meeting>[];
    var hasMore = false;

    // Load every page within a bounded query budget; never silently claim
    // a truncated calendar is complete.
    for (var page = 0; page < 30; page++) {
      final response = await widget.api.get('/meetings', query: {
        'page': '$page',
        'size': '100',
        'sort': 'scheduledStartAt,asc',
        'from': start,
        'to': end,
        if (relationship != null) 'relationship': relationship,
      });
      all.addAll(objectsOf(response.data).map(Meeting.fromJson));
      hasMore = objectOf(response.meta['pagination'])['hasNext'] == true;
      if (!hasMore) break;
    }
    return _CalendarFeed(all, hasMore);
  }

  Future<_CalendarFeed> _load() async {
    if (!myMeetings) return _fetchForRelationship(null);
    final results = await Future.wait([
      _fetchForRelationship('ORGANIZER'),
      _fetchForRelationship('PARTICIPANT'),
    ]);
    final unique = <String, Meeting>{};
    for (final result in results) {
      for (final meeting in result.items) {
        unique[meeting.id] = meeting;
      }
    }
    return _CalendarFeed(unique.values.toList(),
      results.any((result) => result.hasMore));
  }

  void reload() => setState(() => future = _load());

  void changeMonth(DateTime date) {
    if (date.year == month.year && date.month == month.month) return;
    setState(() {
      month = DateTime(date.year, date.month);
      selectedDate = null;
      future = _load();
    });
  }

  bool _sameDay(DateTime first, DateTime second) =>
      first.year == second.year &&
      first.month == second.month &&
      first.day == second.day;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Lịch họp'),
      actions: [
        IconButton(
          tooltip: 'Làm mới lịch họp',
          onPressed: reload,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: AsyncContent<_CalendarFeed>(
      future: future,
      retry: reload,
      builder: (feed) {
        final dated = feed.items.where((meeting) =>
            dateValue(meeting.scheduledStartAt) != null &&
            meeting.status != 'CANCELLED').toList();
        dated.sort((a, b) =>
            (a.scheduledStartAt ?? '').compareTo(b.scheduledStartAt ?? ''));
        final visible = selectedDate == null
            ? dated
            : dated.where((meeting) {
                final date = dateValue(meeting.scheduledStartAt);
                return date != null && _sameDay(date, selectedDate!);
              }).toList();
        return RefreshIndicator(
          onRefresh: () async {
            reload();
            await future;
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 28),
            children: [
              const SectionHeading('Lịch trình',
                subtitle: 'Cuộc họp hiển thị từ Core API theo tháng và quyền truy cập'),
              ContentCard(child: Column(children: [
                Row(children: [
                  IconButton(
                    tooltip: 'Tháng trước',
                    onPressed: () => changeMonth(
                        DateTime(month.year, month.month - 1)),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  Expanded(child: Text(
                    'Tháng ' + month.month.toString() + '/' + month.year.toString(),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700),
                  )),
                  IconButton(
                    tooltip: 'Tháng sau',
                    onPressed: () => changeMonth(
                        DateTime(month.year, month.month + 1)),
                    icon: const Icon(Icons.chevron_right),
                  ),
                ]),
                const SizedBox(height: 12),
                SegmentedButton<bool>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: true, label: Text('Của tôi')),
                    ButtonSegment(value: false, label: Text('Có quyền xem')),
                  ],
                  selected: {myMeetings},
                  onSelectionChanged: (choice) {
                    setState(() {
                      myMeetings = choice.first;
                      selectedDate = null;
                      future = _load();
                    });
                  },
                ),
                const SizedBox(height: 12),
                CalendarDatePicker(
                  key: ValueKey('calendar-' + month.toString()),
                  initialDate: selectedDate ?? DateTime(month.year, month.month),
                  firstDate: DateTime(2020),
                  lastDate: DateTime(2100),
                  onDisplayedMonthChanged: changeMonth,
                  onDateChanged: (day) => setState(() {
                    selectedDate = selectedDate != null &&
                      _sameDay(day, selectedDate!) ? null : day;
                  }),
                ),
                if (selectedDate != null)
                  TextButton.icon(
                    onPressed: () => setState(() => selectedDate = null),
                    icon: const Icon(Icons.clear),
                    label: const Text('Xem cả tháng'),
                  ),
              ])),
              if (feed.hasMore) ContentCard(child: const Row(children: [
                Icon(Icons.warning_amber_outlined, color: Palette.amber),
                SizedBox(width: 10),
                Expanded(child: Text(
                  'Lịch có nhiều dữ liệu hơn giới hạn tải. Hãy dùng bộ lọc tại danh sách cuộc họp.',
                  style: TextStyle(fontSize: 12))),
              ])),
              SectionHeading(selectedDate == null ? 'Cuộc họp trong tháng'
                : 'Cuộc họp ngày ' + DateFormat('dd/MM/yyyy').format(selectedDate!),
                subtitle: visible.length.toString() + ' cuộc họp'),
              if (visible.isEmpty)
                const MessagePanel(
                  icon: Icons.event_busy_outlined,
                  title: 'Chưa có cuộc họp',
                  description: 'Thử chọn ngày hoặc tháng khác.',
                ),
              ...visible.map((meeting) => ContentCard(
                child: InkWell(
                  onTap: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => MeetingDetailPage(
                      api: widget.api, meetingId: meeting.id),
                  )),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Expanded(child: Text(meeting.title,
                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w700))),
                        const SizedBox(width: 8),
                        StatePill(meeting.status),
                      ]),
                      const SizedBox(height: 10),
                      Row(children: [
                        const Icon(Icons.schedule_outlined,
                          size: 17, color: Palette.muted),
                        const SizedBox(width: 8),
                        Expanded(child: Text(
                          dateLabel(meeting.scheduledStartAt) +
                          ' – ' +
                          (dateValue(meeting.scheduledEndAt) == null
                            ? 'Chưa xác định'
                            : DateFormat('HH:mm').format(
                                dateValue(meeting.scheduledEndAt)!)),
                          style: const TextStyle(color: Palette.muted))),
                      ]),
                      const SizedBox(height: 6),
                      Row(children: [
                        const Icon(Icons.meeting_room_outlined,
                          size: 17, color: Palette.muted),
                        const SizedBox(width: 8),
                        Expanded(child: Text(
                          meeting.roomName ?? 'Chưa gán phòng',
                          style: const TextStyle(color: Palette.muted))),
                      ]),
                      const SizedBox(height: 6),
                      Row(children: [
                        const Icon(Icons.people_outline,
                          size: 17, color: Palette.muted),
                        const SizedBox(width: 8),
                        Text(meeting.participantCount.toString() + ' người tham gia',
                          style: const TextStyle(color: Palette.muted)),
                      ]),
                    ]),
                ),
              )),
            ],
          ),
        );
      },
    ),
  );
}
