import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class ResultsPanel extends StatefulWidget {
  final ApiClient api;
  final String meetingId;
  const ResultsPanel({super.key, required this.api, required this.meetingId});

  @override
  State<ResultsPanel> createState() => _ResultsPanelState();
}

class _ResultsPanelState extends State<ResultsPanel> {
  int selected = 0;
  int refreshKey = 0;
  Future<ApiResult> load(String end) =>
      widget.api.get('/meetings/' + widget.meetingId + '/' + end);

  Future<void> action(String path, {Map<String, dynamic> payload = const {}}) async {
    try {
      await widget.api.post('/meetings/' + widget.meetingId + '/' + path, payload);
      if (mounted) {
        showSuccess(context, 'Đã cập nhật kết quả.');
        setState(() => refreshKey++);
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Widget dataArea(String name, Widget Function(dynamic) build) {
    return FutureBuilder<ApiResult>(
      key: ValueKey(name + refreshKey.toString()), future: load(name),
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          final error = snap.error;
          if (error is ApiFailure && error.missing) {
            return const MessagePanel(title: 'Chưa có kết quả xử lý',
              description: 'Biên bản chưa sẵn sàng hoặc bạn chưa được cấp quyền.');
          }
          return MessagePanel(title: 'Không tải được kết quả',
            description: error.toString(),
            onRetry: () => setState(() => refreshKey++));
        }
        return build(snap.data!.data);
      },
    );
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    SingleChildScrollView(scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Wrap(spacing: 8, children: [
        ChoiceChip(label: const Text('Tóm tắt'), selected: selected == 0,
          onSelected: (_) => setState(() => selected = 0)),
        ChoiceChip(label: const Text('Transcript'), selected: selected == 1,
          onSelected: (_) => setState(() => selected = 1)),
        ChoiceChip(label: const Text('Quyết định'), selected: selected == 2,
          onSelected: (_) => setState(() => selected = 2)),
      ])),
    Expanded(child: ListView(padding: const EdgeInsets.all(18), children: [
      if (selected == 0) dataArea('summary', (raw) {
        final data = objectOf(raw);
        final content = textValue(data['content']);
        if (content.isEmpty) return const MessagePanel(title: 'Chưa có bản tóm tắt');
        return Column(children: [
          ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Expanded(child: Text('Tóm tắt cuộc họp',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800))),
                if (data['isStale'] == true) const StatePill('COMPLETED_WITH_WARNINGS',
                  label: 'Cần xem lại'),
              ]),
              const SizedBox(height: 8),
              Text('Phiên bản ' + textValue(data['versionNumber']),
                style: const TextStyle(color: Palette.muted, fontSize: 12)),
              const SizedBox(height: 12),
              SelectableText(content),
              if (data['aiWarnings'] is List &&
                  (data['aiWarnings'] as List).isNotEmpty) ...[
                const Divider(height: 26),
                Text((data['aiWarnings'] as List).join('\n'),
                  style: const TextStyle(color: Palette.amber)),
              ],
            ])),
          OutlinedButton.icon(
            onPressed: () => editSummary(content),
            icon: const Icon(Icons.edit_note), label: const Text('Chỉnh sửa bản tóm tắt')),
        ]);
      }),
      if (selected == 1) dataArea('transcript', (raw) {
        final data = objectOf(raw);
        final segments = objectsOf(data['segments']);
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SectionHeading('Dòng thời gian phát biểu',
            subtitle: 'Nội dung AI có thể cần kiểm tra thủ công.'),
          if (segments.isEmpty) const MessagePanel(title: 'Chưa có transcript'),
          ...segments.map((segment) => ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(textValue(segment['speakerLabel'], 'Speaker'),
                  style: const TextStyle(fontWeight: FontWeight.w800))),
                Text(
                  Duration(milliseconds: (segment['startMs'] as num?)?.toInt() ?? 0)
                    .toString().split('.').first,
                  style: const TextStyle(color: Palette.muted, fontSize: 12)),
              ]),
              const SizedBox(height: 8),
              SelectableText(textValue(segment['text'])),
              if (textValue(segment['qualityStatus']) != 'OK' &&
                  segment['qualityStatus'] != null)
                Padding(padding: const EdgeInsets.only(top: 6),
                  child: StatePill(textValue(segment['qualityStatus']))),
            ]))),
        ]);
      }),
      if (selected == 2) dataArea('decisions', (raw) {
        final decisions = objectsOf(raw);
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SectionHeading('Quyết định chính',
            subtitle: 'Đề xuất AI cần được người có quyền xác nhận.'),
          if (decisions.isEmpty) const MessagePanel(title: 'Chưa có quyết định'),
          ...decisions.map((decision) {
            final id = textValue(decision['id']);
            final status = textValue(decision['status']);
            return ContentCard(child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: [
                StatePill(status),
                const SizedBox(height: 8),
                Text(textValue(decision['content'])),
                if (status == 'PROPOSED') Row(children: [
                  TextButton(onPressed: () => action('decisions/' + id + '/confirm'),
                    child: const Text('Xác nhận')),
                  TextButton(onPressed: () => action('decisions/' + id + '/reject'),
                    child: const Text('Từ chối')),
                ]),
              ]));
          }),
        ]);
      }),
    ])),
  ]);

  Future<void> editSummary(String previous) async {
    final controller = TextEditingController(text: previous);
    final updated = await showDialog<String>(context: context,
      builder: (ctx) => AlertDialog(title: const Text('Chỉnh sửa tóm tắt'),
        content: SizedBox(width: 500,
          child: TextField(controller: controller, maxLines: 12, minLines: 5)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx),
            child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text),
            child: const Text('Lưu')),
        ]));
    controller.dispose();
    if (updated == null || updated.trim().isEmpty || !mounted) return;
    try {
      await widget.api.patch('/meetings/' + widget.meetingId + '/summary',
          {'content': updated.trim()});
      if (mounted) setState(() => refreshKey++);
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }
}
