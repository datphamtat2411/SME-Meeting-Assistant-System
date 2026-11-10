import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'meeting_detail_page.dart';
import 'meeting_form.dart';

class MeetingsPage extends StatefulWidget {
  final ApiClient api;
  const MeetingsPage({super.key, required this.api});

  @override
  State<MeetingsPage> createState() => _MeetingsPageState();
}

class _MeetingsPageState extends State<MeetingsPage> {
  final search = TextEditingController();
  late Future<List<Meeting>> future;
  String? status;
  bool calendar = false;
  DateTime selectedDate = DateTime.now();
  int page = 0;
  bool hasNext = false;
  final List<Meeting> loaded = [];

  @override
  void initState() {
    super.initState();
    reload();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<List<Meeting>> fetch(int nextPage) async {
    final response = await widget.api.get('/meetings', query: {
      'page': nextPage.toString(), 'size': '20', 'sort': 'scheduledStartAt,asc',
      if (status != null) 'status': status!,
      if (search.text.trim().isNotEmpty) 'q': search.text.trim(),
    });
    final items = objectsOf(response.data).map(Meeting.fromJson).toList();
    final pagination = objectOf(response.meta['pagination']);
    hasNext = pagination['hasNext'] == true;
    if (nextPage == 0) loaded.clear();
    loaded.addAll(items);
    page = nextPage;
    return List.of(loaded);
  }

  void reload() => setState(() => future = fetch(0));
  void loadMore() => setState(() => future = fetch(page + 1));

  Future<void> create() async {
    final changed = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true, showDragHandle: true,
      builder: (_) => MeetingForm(api: widget.api));
    if (changed == true && mounted) reload();
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 4),
      child: Column(children: [
        SectionHeading('Cuộc họp', subtitle: 'Lịch họp và nội dung được phân quyền',
          trailing: IconButton(onPressed: reload, icon: const Icon(Icons.refresh))),
        Row(children: [
          Expanded(child: TextField(
            controller: search,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => reload(),
            decoration: InputDecoration(
              hintText: 'Tìm cuộc họp',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: IconButton(icon: const Icon(Icons.close),
                onPressed: () { search.clear(); reload(); })),
          )),
          const SizedBox(width: 8),
          IconButton.filled(
            tooltip: 'Tạo cuộc họp', onPressed: create,
            icon: const Icon(Icons.add)),
        ]),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: DropdownButtonFormField<String>(
            value: status ?? '',
            decoration: const InputDecoration(isDense: true, labelText: 'Trạng thái'),
            items: [
              const DropdownMenuItem(value: '', child: Text('Tất cả')),
              ...meetingStates.entries.map((e) => DropdownMenuItem(
                value: e.key, child: Text(e.value))),
            ],
            onChanged: (v) { status = v == '' ? null : v; reload(); },
          )),
          const SizedBox(width: 8),
          SegmentedButton<bool>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: false, icon: Icon(Icons.view_list)),
              ButtonSegment(value: true, icon: Icon(Icons.calendar_month)),
            ],
            selected: {calendar},
            onSelectionChanged: (v) => setState(() => calendar = v.first),
          ),
        ]),
      ]),
    ),
    Expanded(child: AsyncContent<List<Meeting>>(
      future: future, retry: reload,
      builder: (items) => RefreshIndicator(
        onRefresh: () async { reload(); await future; },
        child: ListView(padding: const EdgeInsets.fromLTRB(18, 10, 18, 24),
          children: [
            if (calendar) ...[
              ContentCard(child: CalendarDatePicker(
                initialDate: selectedDate,
                firstDate: DateTime(2020),
                lastDate: DateTime(2100),
                onDateChanged: (value) => setState(() => selectedDate = value),
              )),
              SectionHeading(dateLabel(selectedDate.toIso8601String(), time: false)),
            ],
            if (items.isEmpty) const MessagePanel(
              title: 'Chưa có cuộc họp', description: 'Tạo cuộc họp đầu tiên hoặc đổi bộ lọc.'),
            ...items.where((m) {
              if (!calendar) return true;
              final date = dateValue(m.scheduledStartAt);
              return date != null && date.year == selectedDate.year &&
                date.month == selectedDate.month && date.day == selectedDate.day;
            }).map((m) => ContentCard(child: InkWell(
              onTap: () async {
                await Navigator.push(context, MaterialPageRoute(
                  builder: (_) => MeetingDetailPage(api: widget.api, meetingId: m.id)));
                if (mounted) reload();
              },
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(m.title, style: const TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w800))),
                  const SizedBox(width: 8), StatePill(m.status),
                ]),
                if (m.description.isNotEmpty) Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(m.description, maxLines: 2, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Palette.muted))),
                const SizedBox(height: 12),
                Row(children: [
                  const Icon(Icons.schedule_outlined, size: 16, color: Palette.muted),
                  const SizedBox(width: 6),
                  Expanded(child: Text(dateLabel(m.scheduledStartAt),
                    style: const TextStyle(fontSize: 12, color: Palette.muted))),
                ]),
                if (m.roomName != null) Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(children: [
                    const Icon(Icons.meeting_room_outlined, size: 16, color: Palette.muted),
                    const SizedBox(width: 6),
                    Text(m.roomName!, style: const TextStyle(color: Palette.muted, fontSize: 12)),
                  ])),
              ]),
            ))),
            if (hasNext) OutlinedButton(onPressed: loadMore,
              child: const Text('Tải thêm cuộc họp')),
          ]),
      ),
    )),
  ]);
}
