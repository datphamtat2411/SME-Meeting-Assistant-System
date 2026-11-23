import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class ActionItemDetailSheet extends StatefulWidget {
  const ActionItemDetailSheet({super.key, required this.api, required this.item});
  final ApiClient api;
  final ActionItem item;

  @override
  State<ActionItemDetailSheet> createState() => _ActionItemDetailSheetState();
}

class _ActionItemDetailSheetState extends State<ActionItemDetailSheet> {
  late final TextEditingController title;
  late final TextEditingController details;
  DateTime? due;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    title = TextEditingController(text: widget.item.title);
    details = TextEditingController(text: widget.item.details);
    due = parseDateOnly(widget.item.dueDate);
  }

  @override
  void dispose() { title.dispose(); details.dispose(); super.dispose(); }

  Future<void> chooseDue() async {
    final next = await showDatePicker(context: context,
      initialDate: due ?? DateTime.now(),
      firstDate: DateTime(2020), lastDate: DateTime(2100));
    if (next != null && mounted) setState(() => due = next);
  }

  Future<void> save() async {
    if (title.text.trim().isEmpty || busy) return;
    setState(() => busy = true);
    try {
      final path = '/action-items/' + widget.item.id;
      final latest = await widget.api.get(path);
      await widget.api.patch(path, {
        'title': title.text.trim(),
        'details': details.text.trim(),
        'dueDate': due == null ? null : dateOnly(due!),
      }, headers: {'If-Match': requireEtag(latest)});
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final editable = !['DONE', 'CANCELLED'].contains(widget.item.status);
    return SafeArea(child: Padding(
      padding: EdgeInsets.fromLTRB(18, 8, 18,
        MediaQuery.viewInsetsOf(context).bottom + 18),
      child: SingleChildScrollView(child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SectionHeading('Chi tiết công việc',
            subtitle: 'Lưu phiên bản mới mà không ghi đè nội dung đã thay đổi.'),
          StatePill(widget.item.status),
          const SizedBox(height: 14),
          TextField(controller: title, maxLength: 500, readOnly: !editable,
            decoration: const InputDecoration(labelText: 'Tên công việc')),
          TextField(controller: details, maxLines: 4, readOnly: !editable,
            decoration: const InputDecoration(labelText: 'Mô tả')),
          const SizedBox(height: 12),
          OutlinedButton.icon(onPressed: editable ? chooseDue : null,
            icon: const Icon(Icons.event),
            label: Text(due == null ? 'Chưa đặt hạn' : dateOnly(due!))),
          if (due != null && editable)
            TextButton(onPressed: () => setState(() => due = null),
              child: const Text('Bỏ hạn hoàn thành')),
          const SizedBox(height: 12),
          ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Người nhận: ' + widget.item.assigneeId),
              const SizedBox(height: 4),
              Text('Cuộc họp: ' + widget.item.meetingId),
              if (widget.item.overdue) const Padding(
                padding: EdgeInsets.only(top: 6),
                child: StatePill('FAILED', label: 'Quá hạn')),
            ])),
          FilledButton.icon(
            onPressed: busy || !editable ? null : save,
            icon: const Icon(Icons.save_outlined),
            label: Text(busy ? 'Đang lưu...' : 'Lưu thay đổi')),
        ]))),
    );
  }
}
