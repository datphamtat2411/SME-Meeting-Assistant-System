import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/command_actions.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class SpeakerMappingPanel extends StatefulWidget {
  const SpeakerMappingPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;

  @override
  State<SpeakerMappingPanel> createState() => _SpeakerMappingPanelState();
}

class _SpeakerMappingPanelState extends State<SpeakerMappingPanel> {
  late Future<List<Map<String, dynamic>>> future;
  bool busy = false;
  @override
  void initState() { super.initState(); reload(); }

  void reload() => setState(() {
    future = widget.api.get('/meetings/' + widget.meetingId + '/speaker-clusters')
      .then((response) => objectsOf(response.data));
  });

  Future<void> assign(String cluster, String? user) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      final transcript = await widget.api.get(
          '/meetings/' + widget.meetingId + '/transcript');
      await widget.api.patch(
        '/meetings/' + widget.meetingId + '/speaker-clusters/' + cluster,
        {'userId': user}, headers: {'If-Match': requireEtag(transcript)});
      if (mounted) { showSuccess(context, 'Đã cập nhật người nói.'); reload(); }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> choose(String cluster) async {
    final search = TextEditingController();
    List<Map<String, dynamic>> found = [];
    final user = await showDialog<String>(context: context,
      builder: (dialog) => StatefulBuilder(builder: (dialog, update) =>
        AlertDialog(title: const Text('Gán người nói'),
          content: SizedBox(width: 430, height: 320,
            child: Column(children: [
              TextField(controller: search,
                decoration: const InputDecoration(
                  labelText: 'Tìm tên/email (Enter để tìm)'),
                onSubmitted: (value) async {
                  if (value.trim().length < 2) return;
                  try {
                    final response = await widget.api.get('/users/meeting-candidates',
                      query: {'q': value.trim(), 'size': '20'});
                    if (dialog.mounted) update(() => found = objectsOf(response.data));
                  } catch (error) {
                    if (dialog.mounted) showFailure(dialog, error);
                  }
                }),
              Expanded(child: ListView(children: found.map((person) =>
                ListTile(title: Text(textValue(person['displayName'])),
                  subtitle: Text(textValue(person['email'])),
                  onTap: () => Navigator.pop(dialog, textValue(person['id'])))).toList())),
            ])),
          actions: [TextButton(onPressed: () => Navigator.pop(dialog),
            child: const Text('Hủy'))],
        )));
    search.dispose();
    if (user != null && mounted) await assign(cluster, user);
  }

  @override
  Widget build(BuildContext context) =>
    AsyncContent<List<Map<String, dynamic>>>(future: future, retry: reload,
      builder: (items) => ListView(padding: const EdgeInsets.all(18), children: [
        const SectionHeading('Nhận diện người nói',
          subtitle: 'Có thể hiệu chỉnh nhãn do AI nhận dạng.'),
        if (items.isEmpty) const MessagePanel(title: 'Chưa có nhóm người nói'),
        ...items.map((entry) => ContentCard(child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const CircleAvatar(child: Icon(Icons.record_voice_over_outlined)),
          title: Text(textValue(entry['label'], 'Speaker')),
          subtitle: Text(textValue(entry['displayName'], 'Chưa gán nhân viên')),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            IconButton(onPressed: busy ? null : () => choose(textValue(entry['id'])),
              icon: const Icon(Icons.person_add_outlined), tooltip: 'Gán người nói'),
            if (entry['userId'] != null)
              IconButton(onPressed: busy ? null :
                () => assign(textValue(entry['id']), null),
                icon: const Icon(Icons.link_off_outlined), tooltip: 'Bỏ gán'),
          ]),
        ))),
      ]));
}
