import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class MeetingForm extends StatefulWidget {
  final ApiClient api;
  const MeetingForm({super.key, required this.api});

  @override
  State<MeetingForm> createState() => _MeetingFormState();
}

class _MeetingFormState extends State<MeetingForm> {
  final form = GlobalKey<FormState>();
  final title = TextEditingController();
  final description = TextEditingController();
  final searchMember = TextEditingController();
  DateTime start = DateTime.now().add(const Duration(hours: 1));
  DateTime end = DateTime.now().add(const Duration(hours: 2));
  String? roomId;
  final Map<String, String> members = {};
  bool saving = false;
  late Future<List<Map<String, dynamic>>> rooms;

  @override
  void initState() {
    super.initState();
    rooms = widget.api.get('/rooms', query: {'size': '100'})
        .then((value) => objectsOf(value.data));
  }

  @override
  void dispose() {
    title.dispose();
    description.dispose();
    searchMember.dispose();
    super.dispose();
  }

  Future<void> chooseDate(bool begin) async {
    final current = begin ? start : end;
    final day = await showDatePicker(context: context,
      initialDate: current, firstDate: DateTime(2020), lastDate: DateTime(2100));
    if (day == null || !mounted) return;
    final clock = await showTimePicker(context: context,
      initialTime: TimeOfDay.fromDateTime(current));
    if (clock == null || !mounted) return;
    setState(() {
      final value = DateTime(day.year, day.month, day.day, clock.hour, clock.minute);
      if (begin) { start = value; if (!end.isAfter(start)) end = start.add(const Duration(hours: 1)); }
      else { end = value; }
    });
  }

  Future<void> addMember() async {
    final query = searchMember.text.trim();
    if (query.length < 2) return;
    try {
      final response = await widget.api.get('/users/meeting-candidates',
        query: {'q': query, 'size': '20'});
      if (!mounted) return;
      final candidates = objectsOf(response.data);
      await showDialog<void>(context: context, builder: (dialogContext) =>
        AlertDialog(title: const Text('Thêm người tham gia'), content: SizedBox(
          width: 380, height: 320,
          child: candidates.isEmpty ? const Text('Không tìm thấy nhân viên.')
            : ListView(children: candidates.map((entry) => ListTile(
              title: Text(textValue(entry['displayName'])),
              subtitle: Text(textValue(entry['email'])),
              onTap: () {
                setState(() => members[textValue(entry['id'])] =
                    textValue(entry['displayName']));
                Navigator.pop(dialogContext);
              },
            )).toList())),
          actions: [TextButton(onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Đóng'))]));
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> save() async {
    if (!(form.currentState?.validate() ?? false)) return;
    if (!end.isAfter(start)) {
      showFailure(context, const ApiFailure(422, 'INVALID_INTERVAL',
          'Giờ kết thúc phải sau giờ bắt đầu.'));
      return;
    }
    setState(() => saving = true);
    try {
      await widget.api.post('/meetings', {
        'title': title.text.trim(),
        'description': description.text.trim(),
        'scheduledStartAt': dateIso(start),
        'scheduledEndAt': dateIso(end),
        'roomId': roomId,
        'participantUserIds': members.keys.toList(),
      });
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(child: Padding(
    padding: EdgeInsets.only(
      left: 18, right: 18, bottom: MediaQuery.viewInsetsOf(context).bottom + 16),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 690),
      child: SingleChildScrollView(child: Form(key: form, child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SectionHeading('Tạo cuộc họp',
            subtitle: 'Mỗi cuộc họp có một người tổ chức và lịch trình riêng.'),
          TextFormField(controller: title,
            maxLength: 255,
            decoration: const InputDecoration(labelText: 'Tên cuộc họp *'),
            validator: (v) => v == null || v.trim().isEmpty ? 'Nhập tên cuộc họp.' : null),
          TextFormField(controller: description, maxLines: 2,
            decoration: const InputDecoration(labelText: 'Mục đích / mô tả')),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: () => chooseDate(true), icon: const Icon(Icons.event),
            label: Text('Bắt đầu: ' + dateLabel(start.toIso8601String()))),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => chooseDate(false), icon: const Icon(Icons.schedule),
            label: Text('Kết thúc: ' + dateLabel(end.toIso8601String()))),
          const SizedBox(height: 14),
          FutureBuilder<List<Map<String, dynamic>>>(
            future: rooms,
            builder: (context, snap) {
              if (!snap.hasData) return const Text('Đang tải phòng họp...');
              return DropdownButtonFormField<String>(
                value: roomId ?? '',
                decoration: const InputDecoration(labelText: 'Phòng họp (tùy chọn)'),
                items: [
                  const DropdownMenuItem(value: '', child: Text('Không chọn phòng')),
                  ...snap.data!.where((r) => r['status'] == 'ACTIVE').map((r) =>
                    DropdownMenuItem(
                      value: textValue(r['id']),
                      child: Text(textValue(r['name'])))),
                ],
                onChanged: (v) => setState(() => roomId = v == '' ? null : v),
              );
            }),
          const SizedBox(height: 12),
          TextField(controller: searchMember,
            decoration: InputDecoration(labelText: 'Tìm người tham gia',
              suffixIcon: IconButton(
                onPressed: addMember, icon: const Icon(Icons.person_add_alt_1)))),
          if (members.isNotEmpty) Wrap(spacing: 6, children: members.entries.map((member) =>
            InputChip(label: Text(member.value), onDeleted: () =>
              setState(() => members.remove(member.key)))).toList()),
          const SizedBox(height: 18),
          FilledButton.icon(onPressed: saving ? null : save,
            icon: const Icon(Icons.add), label: Text(saving ? 'Đang lưu...' : 'Tạo cuộc họp')),
          const SizedBox(height: 12),
          const Text('Xung đột phòng họp và quyền truy cập được backend kiểm tra.',
            textAlign: TextAlign.center, style: TextStyle(color: Palette.muted, fontSize: 12)),
        ],
      ))),
    ),
  ));
}
