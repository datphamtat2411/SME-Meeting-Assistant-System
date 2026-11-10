import 'dart:math';
import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/command_actions.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class SummaryHistoryPanel extends StatefulWidget {
  const SummaryHistoryPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;
  @override
  State<SummaryHistoryPanel> createState() => _SummaryHistoryPanelState();
}

class _SummaryHistoryPanelState extends State<SummaryHistoryPanel> {
  late Future<ApiResult> current;
  late Future<List<Map<String, dynamic>>> versions;
  bool busy = false;
  @override
  void initState() { super.initState(); reload(); }

  void reload() => setState(() {
    final path = '/meetings/' + widget.meetingId + '/summary';
    current = widget.api.get(path);
    versions = widget.api.get(path + '/versions', query: {'page': '0', 'size': '50'})
      .then((r) => objectsOf(r.data));
  });

  Future<void> edit(ApiResult response) async {
    final ctrl = TextEditingController(text: textValue(objectOf(response.data)['content']));
    final ok = await showDialog<bool>(context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa tóm tắt'),
        content: SizedBox(width: 500, child: TextField(controller: ctrl,
          maxLength: 20000, minLines: 5, maxLines: 12)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: const Text('Lưu')),
        ]));
    final value = ctrl.text.trim();
    ctrl.dispose();
    if (ok != true || value.isEmpty || !mounted) return;
    setState(() => busy = true);
    try {
      await widget.api.patch('/meetings/' + widget.meetingId + '/summary',
        {'content': value}, headers: {'If-Match': requireEtag(response)});
      if (mounted) { showSuccess(context, 'Đã lưu phiên bản mới.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> activateVersion(String id) async {
    setState(() => busy = true);
    try {
      final fresh = await widget.api.get('/meetings/' + widget.meetingId + '/summary');
      await widget.api.post('/meetings/' + widget.meetingId +
        '/summary/versions/' + id + '/activate', {},
        headers: {'If-Match': requireEtag(fresh)});
      if (mounted) { showSuccess(context, 'Đã kích hoạt phiên bản.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> regenerate() async {
    final ok = await confirmCommand(context,
      title: 'Tạo lại tóm tắt AI?',
      description: 'Tạo một tác vụ xử lý mới. Phiên bản cũ vẫn được lưu.',
      confirmLabel: 'Tạo tác vụ');
    if (!ok || !mounted) return;
    setState(() => busy = true);
    try {
      final rand = Random.secure();
      final key = List<int>.generate(16, (_) => rand.nextInt(256))
        .map((v) => v.toRadixString(16).padLeft(2, '0')).join();
      final response = await widget.api.post(
        '/meetings/' + widget.meetingId + '/summary/regenerate', {},
        headers: {'Idempotency-Key': key});
      if (mounted) {
        showSuccess(context, 'Đã tiếp nhận tác vụ ' +
          textValue(objectOf(response.data)['processingJobId']));
        reload();
      }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18), children: [
      SectionHeading('Tóm tắt cuộc họp',
        trailing: IconButton(onPressed: reload, icon: const Icon(Icons.refresh))),
      FutureBuilder<ApiResult>(future: current, builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) return MessagePanel(title: 'Tóm tắt chưa sẵn sàng',
          description: snap.error.toString(), onRetry: reload);
        final value = snap.data!;
        final summary = objectOf(value.data);
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('Phiên bản ' + textValue(summary['versionNumber']),
                  style: const TextStyle(fontWeight: FontWeight.w700))),
                if (summary['isStale'] == true)
                  const StatePill('COMPLETED_WITH_WARNINGS', label: 'Nguồn đã cập nhật'),
              ]),
              const SizedBox(height: 10),
              SelectableText(textValue(summary['content'])),
              if (summary['aiWarnings'] is List &&
                  (summary['aiWarnings'] as List).isNotEmpty)
                Text((summary['aiWarnings'] as List).join('\n')),
            ])),
          Row(children: [
            Expanded(child: OutlinedButton.icon(
              onPressed: busy ? null : () => edit(value),
              icon: const Icon(Icons.edit_outlined), label: const Text('Chỉnh sửa'))),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton.icon(
              onPressed: busy ? null : regenerate,
              icon: const Icon(Icons.auto_awesome), label: const Text('Tạo lại AI'))),
          ]),
        ]);
      }),
      const SizedBox(height: 16),
      const SectionHeading('Lịch sử phiên bản'),
      AsyncContent<List<Map<String, dynamic>>>(
        future: versions, retry: reload,
        builder: (items) => Column(children: [
          if (items.isEmpty) const MessagePanel(title: 'Chưa có lịch sử'),
          ...items.map((item) => ContentCard(child: ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('Phiên bản ' + textValue(item['versionNumber'])),
            subtitle: Text(textValue(item['sourceType']) +
                ' · ' + textValue(item['qualityStatus'])),
            trailing: item['isCurrent'] == true
              ? const StatePill('CONFIRMED', label: 'Hiện tại')
              : TextButton(onPressed: busy ? null :
                  () => activateVersion(textValue(item['id'])),
                  child: const Text('Kích hoạt')),
          ))),
        ])),
    ]);
}
