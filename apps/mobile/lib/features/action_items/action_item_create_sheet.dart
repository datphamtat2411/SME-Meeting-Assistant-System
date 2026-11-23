import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/date_labels.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class ActionItemCreateSheet extends StatefulWidget {
  const ActionItemCreateSheet({super.key, required this.api});
  final ApiClient api;
  @override
  State<ActionItemCreateSheet> createState() => _ActionItemCreateSheetState();
}

class _ActionItemCreateSheetState extends State<ActionItemCreateSheet> {
  final form = GlobalKey<FormState>();
  final title = TextEditingController();
  final details = TextEditingController();
  late Future<List<Meeting>> meetings;
  String? meetingId;
  late String assigneeId;
  String assigneeName = 'Tôi';
  DateTime? due;
  bool saving = false;

  @override
  void initState() {
    super.initState();
    assigneeId = widget.api.userId;
    meetings = widget.api.get('/meetings', query: {'page': '0', 'size': '100'})
      .then((r) => objectsOf(r.data).map(Meeting.fromJson).toList());
  }

  @override
  void dispose() { title.dispose(); details.dispose(); super.dispose(); }

  Future<void> pickAssignee() async {
    final search = TextEditingController();
    List<Map<String, dynamic>> found = [];
    final chosen = await showDialog<Map<String, dynamic>>(
      context: context, builder: (dialog) => StatefulBuilder(
        builder: (dialog, update) => AlertDialog(
          title: const Text('Giao cho thành viên'),
          content: SizedBox(width: 440, height: 320, child: Column(children: [
            TextField(controller: search,
              decoration: InputDecoration(
                labelText: 'Tìm tên/email',
                suffixIcon: IconButton(onPressed: () async {
                  if (search.text.trim().length < 2) return;
                  try {
                    final data = await widget.api.get('/users/meeting-candidates',
                      query: {'q': search.text.trim(), 'size': '20'});
                    if (dialog.mounted) update(() => found = objectsOf(data.data));
                  } catch (e) { if (dialog.mounted) showFailure(dialog, e); }
                }, icon: const Icon(Icons.search)),
              )),
            Expanded(child: ListView(children: found.map((member) =>
              ListTile(title: Text(textValue(member['displayName'])),
                subtitle: Text(textValue(member['email'])),
                onTap: () => Navigator.pop(dialog, member))).toList())),
          ])),
          actions: [TextButton(onPressed: () => Navigator.pop(dialog),
            child: const Text('Đóng'))],
        )));
    search.dispose();
    if (chosen != null && mounted) setState(() {
      assigneeId = textValue(chosen['id']);
      assigneeName = textValue(chosen['displayName'], 'Thành viên');
    });
  }

  Future<void> submit() async {
    if (!(form.currentState?.validate() ?? false) || saving) return;
    setState(() => saving = true);
    try {
      await widget.api.post('/action-items', {
        'meetingId': meetingId,
        'title': title.text.trim(),
        'details': details.text.trim(),
        'assigneeUserId': assigneeId,
        'dueDate': due == null ? null : dateOnly(due!),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => saving = false); }
  }

  @override
  Widget build(BuildContext context) => SafeArea(child: Padding(
    padding: EdgeInsets.fromLTRB(18, 8, 18,
      MediaQuery.viewInsetsOf(context).bottom + 18),
    child: SingleChildScrollView(child: Form(key: form,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionHeading('Tạo công việc',
          subtitle: 'Một công việc thuộc đúng cuộc họp và người phụ trách.'),
        FutureBuilder<List<Meeting>>(future: meetings, builder: (context, snap) {
          if (snap.hasError) return MessagePanel(
            title: 'Không tải được cuộc họp', description: snap.error.toString());
          if (!snap.hasData) return const LinearProgressIndicator();
          return DropdownButtonFormField<String>(
            isExpanded: true, initialValue: meetingId,
            decoration: const InputDecoration(labelText: 'Cuộc họp *'),
            items: snap.data!.map((m) => DropdownMenuItem(
              value: m.id, child: Text(m.title, overflow: TextOverflow.ellipsis))).toList(),
            onChanged: (v) => setState(() => meetingId = v),
            validator: (v) => v == null ? 'Hãy chọn cuộc họp.' : null);
        }),
        const SizedBox(height: 12),
        TextFormField(controller: title, maxLength: 500,
          decoration: const InputDecoration(labelText: 'Tên công việc *'),
          validator: (v) => v == null || v.trim().isEmpty ? 'Nhập tên công việc.' : null),
        TextField(controller: details, maxLines: 3,
          decoration: const InputDecoration(labelText: 'Mô tả')),
        const SizedBox(height: 12),
        OutlinedButton.icon(onPressed: pickAssignee,
          icon: const Icon(Icons.person_search_outlined),
          label: Text('Phụ trách: ' + assigneeName)),
        const SizedBox(height: 8),
        OutlinedButton.icon(onPressed: () async {
          final selected = await showDatePicker(context: context,
            firstDate: DateTime(2020), lastDate: DateTime(2100),
            initialDate: due ?? DateTime.now());
          if (selected != null && mounted) setState(() => due = selected);
        }, icon: const Icon(Icons.event),
          label: Text(due == null ? 'Chọn hạn hoàn thành' : dateOnly(due!))),
        const SizedBox(height: 16),
        FilledButton.icon(onPressed: saving ? null : submit,
          icon: const Icon(Icons.add_task), label: Text(saving ? 'Đang tạo...' : 'Tạo công việc')),
      ]))),
  ));
}
