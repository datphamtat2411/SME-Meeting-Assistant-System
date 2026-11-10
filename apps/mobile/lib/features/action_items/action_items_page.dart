import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class ActionItemsPage extends StatefulWidget {
  final ApiClient api;
  const ActionItemsPage({super.key, required this.api});

  @override
  State<ActionItemsPage> createState() => _ActionItemsPageState();
}

class _ActionItemsPageState extends State<ActionItemsPage> {
  late Future<List<ActionItem>> future;
  String? filter;
  bool mine = true;

  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() => setState(() {
    future = widget.api.get('/action-items', query: {
      'page': '0', 'size': '100', 'sort': 'createdAt,desc',
      if (filter != null) 'status': filter!,
      if (mine) 'assignee': 'me',
    }).then((v) => objectsOf(v.data).map(ActionItem.new).toList());
  });

  Future<void> changeStatus(ActionItem item, String action) async {
    try {
      final current = await widget.api.get('/action-items/' + item.id);
      final etag = current.etag;
      if (etag == null) {
        throw const ApiFailure(0, 'MISSING_ETAG', 'Action-item version is not available.');
      }
      await widget.api.post('/action-items/' + item.id + '/' + action, {},
        headers: {'If-Match': etag});
      if (mounted) { showSuccess(context, 'Đã cập nhật công việc.'); reload(); }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> add() async {
    final title = TextEditingController();
    final details = TextEditingController();
    final form = GlobalKey<FormState>();
    DateTime? due;
    String? meetingId;
    List<Meeting> meetings = [];
    try {
      meetings = objectsOf((await widget.api.get('/meetings', query: {
        'page': '0', 'size': '100',
      })).data).map(Meeting.fromJson).toList();
    } catch (error) {
      if (mounted) showFailure(context, error);
      title.dispose();
      details.dispose();
      return;
    }
    if (!mounted) { title.dispose(); details.dispose(); return; }
    final saved = await showModalBottomSheet<bool>(context: context,
      isScrollControlled: true, showDragHandle: true,
      builder: (sheet) => StatefulBuilder(builder: (sheet, setSheet) =>
        Padding(
          padding: EdgeInsets.fromLTRB(18, 10, 18,
            MediaQuery.viewInsetsOf(sheet).bottom + 20),
          child: SingleChildScrollView(child: Form(key: form,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const SectionHeading('Thêm công việc',
                subtitle: 'Công việc thủ công được tạo theo cuộc họp.'),
              DropdownButtonFormField<String>(
                initialValue: meetingId,
                decoration: const InputDecoration(labelText: 'Cuộc họp *'),
                items: meetings.map((m) => DropdownMenuItem(
                  value: m.id, child: Text(m.title, overflow: TextOverflow.ellipsis))).toList(),
                onChanged: (v) => setSheet(() => meetingId = v),
                validator: (v) => v == null ? 'Vui lòng chọn cuộc họp' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(controller: title,
                maxLength: 500,
                decoration: const InputDecoration(labelText: 'Tên công việc *'),
                validator: (v) => v == null || v.trim().isEmpty ? 'Nhập tên công việc.' : null),
              TextField(controller: details, maxLines: 2,
                decoration: const InputDecoration(labelText: 'Chi tiết')),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () async {
                  final picked = await showDatePicker(context: sheet,
                    initialDate: due ?? DateTime.now(),
                    firstDate: DateTime(2020), lastDate: DateTime(2100));
                  if (picked != null) setSheet(() => due = picked);
                },
                icon: const Icon(Icons.event),
                label: Text(due == null ? 'Chọn hạn hoàn thành'
                  : dateLabel(due!.toIso8601String(), time: false)),
              ),
              const SizedBox(height: 12),
              FilledButton(onPressed: () async {
                if (!(form.currentState?.validate() ?? false)) return;
                try {
                  await widget.api.post('/action-items', {
                    'meetingId': meetingId,
                    'title': title.text.trim(),
                    'details': details.text.trim(),
                    'assigneeUserId': widget.api.userId,
                    if (due != null) 'dueDate':
                      due!.year.toString().padLeft(4, '0') + '-' +
                      due!.month.toString().padLeft(2, '0') + '-' +
                      due!.day.toString().padLeft(2, '0'),
                  });
                  if (sheet.mounted) Navigator.pop(sheet, true);
                } catch (error) {
                  if (sheet.mounted) showFailure(sheet, error);
                }
              }, child: const Text('Tạo công việc')),
            ]))),
        )));
    title.dispose();
    details.dispose();
    if (saved == true && mounted) reload();
  }

  Widget actions(ActionItem item) {
    final commands = switch (item.status) {
      'PROPOSED' => const [('confirm', 'Duyệt'), ('reject', 'Từ chối')],
      'OPEN' => const [('start', 'Bắt đầu'), ('cancel', 'Hủy')],
      'IN_PROGRESS' => const [('complete', 'Hoàn thành'), ('cancel', 'Hủy')],
      'DONE' => const [('reopen', 'Mở lại')],
      _ => const <(String, String)>[],
    };
    return Wrap(spacing: 4, children: [
      for (final (command, label) in commands)
        TextButton(onPressed: () => changeStatus(item, command),
          child: Text(label)),
    ]);
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 18, 18, 8),
      child: Column(children: [
        SectionHeading('Công việc sau họp',
          subtitle: 'Theo dõi đầu việc và đề xuất AI',
          trailing: IconButton(onPressed: add, icon: const Icon(Icons.add_circle_outline))),
        Row(children: [
          Expanded(child: DropdownButtonFormField<String>(
            initialValue: filter ?? '',
            decoration: const InputDecoration(labelText: 'Trạng thái', isDense: true),
            items: [
              const DropdownMenuItem(value: '', child: Text('Tất cả')),
              ...actionStates.entries.where((e) => e.key != 'REJECTED').map((e) =>
                DropdownMenuItem(value: e.key, child: Text(e.value))),
            ],
            onChanged: (v) { filter = v == '' ? null : v; reload(); },
          )),
          const SizedBox(width: 8),
          FilterChip(label: const Text('Được giao cho tôi'),
            selected: mine, onSelected: (v) { mine = v; reload(); }),
        ]),
      ]),
    ),
    Expanded(child: AsyncContent<List<ActionItem>>(
      future: future, retry: reload,
      builder: (tasks) => RefreshIndicator(
        onRefresh: () async { reload(); await future; },
        child: ListView(padding: const EdgeInsets.all(18), children: [
          if (tasks.isEmpty) const MessagePanel(title: 'Không có đầu việc',
            description: 'Các công việc hiện có sẽ xuất hiện tại đây.'),
          ...tasks.map((item) => ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(item.title,
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800))),
                StatePill(item.status),
              ]),
              if (item.details.isNotEmpty) Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(item.details, maxLines: 3,
                  style: const TextStyle(color: Palette.muted))),
              const SizedBox(height: 10),
              Row(children: [
                const Icon(Icons.event_outlined, size: 16, color: Palette.muted),
                const SizedBox(width: 6),
                Text(item.dueDate == null ? 'Chưa đặt hạn' : 'Hạn: ' + item.dueDate!,
                  style: TextStyle(fontSize: 12,
                    color: item.overdue ? Palette.red : Palette.muted)),
                if (item.overdue) const Padding(
                  padding: EdgeInsets.only(left: 8), child: StatePill('FAILED', label: 'Quá hạn')),
              ]),
              if (actions(item) case final buttonRow) buttonRow,
            ]))),
        ]),
      ),
    )),
  ]);
}
