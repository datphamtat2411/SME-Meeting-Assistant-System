import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/command_actions.dart';
import '../../core/meeting_models.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class MeetingParticipants extends StatefulWidget {
  const MeetingParticipants({super.key, required this.api, required this.meeting});
  final ApiClient api;
  final Meeting meeting;

  @override
  State<MeetingParticipants> createState() => _MeetingParticipantsState();
}

class _MeetingParticipantsState extends State<MeetingParticipants> {
  late Future<List<MeetingParticipant>> _future;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() => setState(() {
    _future = widget.api.get('/meetings/' + widget.meeting.id + '/participants')
      .then((r) => objectsOf(r.data).map(MeetingParticipant.fromJson).toList());
  });

  Future<void> _mutate(String path, {Map<String, dynamic>? body}) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final fresh = await widget.api.get('/meetings/' + widget.meeting.id);
      final tag = requireEtag(fresh);
      if (body == null) {
        await widget.api.delete(path, headers: {'If-Match': tag});
      } else {
        await widget.api.post(path, body, headers: {'If-Match': tag});
      }
      if (mounted) {
        showSuccess(context, 'Danh sách tham gia đã được cập nhật.');
        _reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _addMember() async {
    final search = TextEditingController();
    List<Map<String, dynamic>> candidates = [];
    bool loading = false;
    await showDialog<void>(context: context, builder: (dialog) =>
      StatefulBuilder(builder: (dialog, update) =>
        AlertDialog(
          title: const Text('Mời nhân viên'),
          content: SizedBox(
            width: 460, height: 380,
            child: Column(children: [
              TextField(
                controller: search,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'Tìm tên hoặc email',
                  suffixIcon: IconButton(
                    onPressed: loading ? null : () async {
                      if (search.text.trim().length < 2) return;
                      update(() => loading = true);
                      try {
                        final r = await widget.api.get('/users/meeting-candidates',
                          query: {'q': search.text.trim(), 'size': '20'});
                        if (dialog.mounted) update(() => candidates = objectsOf(r.data));
                      } catch (e) {
                        if (dialog.mounted) showFailure(dialog, e);
                      } finally {
                        if (dialog.mounted) update(() => loading = false);
                      }
                    },
                    icon: const Icon(Icons.search),
                  ),
                ),
                onSubmitted: (q) async {
                  if (q.trim().length < 2) return;
                  update(() => loading = true);
                  try {
                    final r = await widget.api.get('/users/meeting-candidates',
                      query: {'q': q.trim(), 'size': '20'});
                    if (dialog.mounted) update(() => candidates = objectsOf(r.data));
                  } catch (e) {
                    if (dialog.mounted) showFailure(dialog, e);
                  } finally {
                    if (dialog.mounted) update(() => loading = false);
                  }
                },
              ),
              if (loading) const LinearProgressIndicator(),
              Expanded(child: candidates.isEmpty
                ? const Center(child: Text('Nhập ít nhất 2 ký tự để tìm nhân viên.'))
                : ListView(children: candidates.map((candidate) => ListTile(
                  title: Text(textValue(candidate['displayName'])),
                  subtitle: Text(textValue(candidate['email'])),
                  trailing: const Icon(Icons.person_add_outlined),
                  onTap: () {
                    Navigator.pop(dialog);
                    _mutate('/meetings/' + widget.meeting.id + '/participants',
                      body: {'userId': candidate['id']});
                  },
                )).toList())),
            ]),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(dialog),
            child: const Text('Đóng'))],
        )));
    search.dispose();
  }

  Future<void> _remove(MeetingParticipant person) async {
    final yes = await confirmCommand(context,
      title: 'Xóa thành viên khỏi cuộc họp?',
      description: 'Quyền truy cập nội dung cuộc họp sẽ được đánh giá lại bởi máy chủ.',
      confirmLabel: 'Xóa thành viên', destructive: true);
    if (!yes || !mounted) return;
    await _mutate('/meetings/' + widget.meeting.id + '/participants/' + person.userId);
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      SectionHeading('Người tham gia',
        subtitle: 'Danh sách thành viên thuộc tổ chức',
        trailing: IconButton(
          onPressed: _saving || ['ENDED', 'CANCELLED'].contains(widget.meeting.status)
            ? null : _addMember,
          icon: const Icon(Icons.person_add_alt_1_outlined))),
      AsyncContent<List<MeetingParticipant>>(future: _future, retry: _reload,
        builder: (people) => Column(children: [
          if (people.isEmpty) const MessagePanel(title: 'Chưa có thành viên'),
          ...people.map((person) => ContentCard(child: ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const CircleAvatar(child: Icon(Icons.person_outline)),
            title: Text(person.displayName),
            subtitle: Text(person.userId == widget.meeting.organizerId
                ? 'Người tổ chức' : 'Người tham gia'),
            trailing: person.userId == widget.meeting.organizerId ||
                ['ENDED', 'CANCELLED'].contains(widget.meeting.status) ||
                _saving ? null : IconButton(
              tooltip: 'Xóa thành viên',
              onPressed: () => _remove(person),
              icon: const Icon(Icons.person_remove_outlined),
            ),
          ))),
        ])),
    ]);
}
