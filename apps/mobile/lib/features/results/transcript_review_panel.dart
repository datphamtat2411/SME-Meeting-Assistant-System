import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';

class TranscriptReviewPanel extends StatefulWidget {
  const TranscriptReviewPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;

  @override
  State<TranscriptReviewPanel> createState() => _TranscriptReviewPanelState();
}

class _TranscriptReviewPanelState extends State<TranscriptReviewPanel> {
  final search = TextEditingController();
  late Future<List<SpeechSegment>> future;
  bool saving = false;
  @override
  void initState() { super.initState(); reload(); }
  @override
  void dispose() { search.dispose(); super.dispose(); }

  void reload() => setState(() {
    future = widget.api.get('/meetings/' + widget.meetingId + '/transcript')
      .then(speechSegments);
  });

  Future<void> correct(SpeechSegment segment) async {
    final controller = TextEditingController(text: segment.text);
    final reason = TextEditingController();
    final save = await showDialog<bool>(context: context,
      builder: (dialog) => AlertDialog(
        title: Text('Kiểm tra đoạn ' + durationLabel(segment.startMs)),
        content: SizedBox(width: 460,
          child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: controller, maxLength: 20000,
              minLines: 3, maxLines: 9,
              decoration: const InputDecoration(labelText: 'Lời nói chính xác')),
            TextField(controller: reason, maxLength: 1000,
              decoration: const InputDecoration(labelText: 'Lý do chỉnh sửa')),
          ]))),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu')),
        ],
      ));
    if (save != true || controller.text.trim().isEmpty || !mounted) {
      controller.dispose(); reason.dispose(); return;
    }
    setState(() => saving = true);
    try {
      await widget.api.patch(
        '/meetings/' + widget.meetingId + '/transcript/segments/' + segment.id,
        {'text': controller.text.trim(), 'reason': reason.text.trim()},
        headers: {'If-Match': '"s-' + segment.id + '-' +
          segment.version.toString() + '"'});
      if (mounted) { showSuccess(context, 'Đã lưu chỉnh sửa.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally {
      controller.dispose(); reason.dispose();
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
      child: TextField(controller: search,
        decoration: const InputDecoration(
          prefixIcon: Icon(Icons.search), hintText: 'Tìm lời nói hoặc nhãn người nói'),
        onChanged: (_) => setState(() {}))),
    Expanded(child: AsyncContent<List<SpeechSegment>>(
      future: future, retry: reload,
      builder: (segments) {
        final query = search.text.trim().toLowerCase();
        final visible = segments.where((s) => s.text.toLowerCase().contains(query)
          || s.speakerLabel.toLowerCase().contains(query)).toList();
        return RefreshIndicator(
          onRefresh: () async { reload(); await future; },
          child: ListView(padding: const EdgeInsets.all(18), children: [
            SectionHeading('Transcript',
              subtitle: segments.length.toString() + ' đoạn phát biểu có dấu thời gian'),
            if (segments.isEmpty) const MessagePanel(title: 'Transcript chưa sẵn sàng'),
            if (segments.isNotEmpty && visible.isEmpty)
              const MessagePanel(title: 'Không tìm thấy nội dung phù hợp'),
            ...visible.map((s) => ContentCard(child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text(s.speakerLabel,
                    style: const TextStyle(fontWeight: FontWeight.w700))),
                  Text(durationLabel(s.startMs) + '–' + durationLabel(s.endMs),
                    style: const TextStyle(fontSize: 12, color: Palette.muted)),
                  IconButton(icon: const Icon(Icons.edit_note_outlined),
                    onPressed: saving ? null : () => correct(s),
                    tooltip: 'Sửa đoạn văn bản'),
                ]),
                SelectableText(s.text),
                if (s.quality.isNotEmpty && s.quality != 'OK')
                  Padding(padding: const EdgeInsets.only(top: 8),
                    child: StatePill(s.quality)),
              ]))),
          ]),
        );
      },
    )),
  ]);
}
