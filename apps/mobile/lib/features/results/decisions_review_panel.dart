import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';

class DecisionsReviewPanel extends StatefulWidget {
  const DecisionsReviewPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;
  @override
  State<DecisionsReviewPanel> createState() => _DecisionsReviewPanelState();
}

class _DecisionsReviewPanelState extends State<DecisionsReviewPanel> {
  late Future<List<MeetingDecision>> future;
  bool busy = false;
  @override
  void initState() { super.initState(); reload(); }

  void reload() => setState(() {
    future = widget.api.get('/meetings/' + widget.meetingId + '/decisions',
      query: {'page': '0', 'size': '100'})
      .then((r) => objectsOf(r.data).map(MeetingDecision.fromJson).toList());
  });

  Future<void> edit({MeetingDecision? decision}) async {
    final ctrl = TextEditingController(text: decision?.content ?? '');
    final ok = await showDialog<bool>(context: context, builder: (dialog) =>
      AlertDialog(
        title: Text(decision == null ? 'Tạo quyết định' : 'Sửa quyết định'),
        content: SizedBox(width: 480, child: TextField(
          controller: ctrl, minLines: 3, maxLines: 8, maxLength: 5000)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu')),
        ]));
    final value = ctrl.text.trim();
    ctrl.dispose();
    if (ok != true || value.isEmpty || !mounted) return;
    setState(() => busy = true);
    try {
      final url = '/meetings/' + widget.meetingId + '/decisions';
      if (decision == null) {
        await widget.api.post(url, {'content': value, 'evidenceSegmentIds': []});
      } else {
        await widget.api.patch(url + '/' + decision.id, {'content': value},
          headers: {'If-Match': decision.etag});
      }
      if (mounted) { showSuccess(context, 'Đã lưu quyết định.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> review(MeetingDecision decision, bool confirm) async {
    if (!await confirmCommand(context,
      title: confirm ? 'Xác nhận quyết định?' : 'Từ chối đề xuất?',
      description: 'Hành động này thay đổi trạng thái quyết định chính thức.',
      destructive: !confirm, confirmLabel: confirm ? 'Xác nhận' : 'Từ chối')) return;
    setState(() => busy = true);
    try {
      await widget.api.post('/meetings/' + widget.meetingId + '/decisions/' +
        decision.id + (confirm ? '/confirm' : '/reject'), {},
        headers: {'If-Match': decision.etag});
      if (mounted) { showSuccess(context, 'Đã cập nhật quyết định.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
      child: SectionHeading('Quyết định',
        subtitle: 'Đề xuất AI cần xác nhận trước khi trở thành chính thức.',
        trailing: IconButton(onPressed: busy ? null : () => edit(),
          icon: const Icon(Icons.add_circle_outline)))),
    Expanded(child: AsyncContent<List<MeetingDecision>>(
      future: future, retry: reload,
      builder: (items) => RefreshIndicator(
        onRefresh: () async { reload(); await future; },
        child: ListView(padding: const EdgeInsets.all(18), children: [
          if (items.isEmpty) const MessagePanel(title: 'Chưa có quyết định'),
          ...items.map((d) => ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                StatePill(d.status),
                if (d.stale) const Padding(padding: EdgeInsets.only(left: 8),
                  child: StatePill('COMPLETED_WITH_WARNINGS', label: 'Cần đối chiếu')),
              ]),
              const SizedBox(height: 9),
              SelectableText(d.content),
              Wrap(children: [
                TextButton.icon(onPressed: busy ? null : () => edit(decision: d),
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Sửa')),
                if (d.status == 'PROPOSED') ...[
                  TextButton(onPressed: busy ? null : () => review(d, true),
                    child: const Text('Xác nhận')),
                  TextButton(onPressed: busy ? null : () => review(d, false),
                    child: const Text('Từ chối', style: TextStyle(color: Palette.red))),
                ],
              ]),
            ]))),
        ]),
      )),
    ),
  ]);
}
