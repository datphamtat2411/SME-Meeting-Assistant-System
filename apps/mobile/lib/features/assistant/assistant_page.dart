import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class AssistantPage extends StatefulWidget {
  final ApiClient api;
  const AssistantPage({super.key, required this.api});

  @override
  State<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends State<AssistantPage> {
  final input = TextEditingController();
  final scroll = ScrollController();
  late Future<List<Map<String, dynamic>>> future;
  String? conversationId;
  List<Map<String, dynamic>> messages = [];
  bool sending = false;
  String? unsupported;

  @override
  void initState() {
    super.initState();
    loadConversations();
  }

  void loadConversations() => setState(() {
    future = widget.api.get('/assistant/conversations', query: {
      'page': '0', 'size': '20',
    }).then((response) {
      unsupported = null;
      return objectsOf(response.data);
    }).catchError((Object error) {
      if (error is ApiFailure && error.missing) {
        unsupported = 'Core API hiện chưa triển khai Assistant conversations.';
      }
      throw error;
    });
  });

  @override
  void dispose() {
    input.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<void> openConversation(String id) async {
    try {
      final result = await widget.api.get('/assistant/conversations/' + id);
      final data = objectOf(result.data);
      if (mounted) setState(() {
        conversationId = id;
        messages = objectsOf(data['messages']);
      });
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> createConversation() async {
    try {
      final result = await widget.api.post('/assistant/conversations', {});
      final data = objectOf(result.data);
      if (textValue(data['id']).isEmpty) {
        throw const ApiFailure(0, 'INVALID_RESPONSE', 'Không nhận được hội thoại mới.');
      }
      if (mounted) {
        setState(() { conversationId = textValue(data['id']); messages.clear(); });
        loadConversations();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> ask() async {
    final text = input.text.trim();
    if (text.isEmpty || conversationId == null || sending) return;
    setState(() => sending = true);
    try {
      // Request/response detail must be finalized with the Assistant OpenAPI.
      // Never fabricate an answer if the service cannot return source-backed data.
      await widget.api.post('/assistant/conversations/' +
          conversationId! + '/messages', {'content': text});
      input.clear();
      await openConversation(conversationId!);
      if (mounted && scroll.hasClients) {
        scroll.animateTo(scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Widget messageTile(Map<String, dynamic> item) {
    final role = textValue(item['role']);
    final mine = role == 'USER' || role.toLowerCase() == 'user';
    final sourceItems = objectsOf(item['sources']);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560),
        child: ContentCard(child: Column(
          crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(mine ? 'Bạn' : 'AI Assistant',
              style: const TextStyle(color: Palette.muted, fontSize: 12,
                fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            SelectableText(textValue(item['content'],
              textValue(item['answer'], 'Không có nội dung trả lời.'))),
            if (sourceItems.isNotEmpty) ...[
              const Divider(),
              const Text('Nguồn tham chiếu',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 12)),
              ...sourceItems.map((source) => Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Row(children: [
                  const Icon(Icons.link, size: 14, color: Palette.blue),
                  const SizedBox(width: 5),
                  Expanded(child: Text(
                    textValue(source['meetingTitle'],
                      textValue(source['excerpt'], 'Meeting source')),
                    style: const TextStyle(fontSize: 12, color: Palette.muted))),
                ]))),
            ],
          ]),
        )),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Column(children: [
    Padding(padding: const EdgeInsets.fromLTRB(18, 18, 18, 4),
      child: SectionHeading('AI Assistant',
        subtitle: 'Hỏi đáp dựa trên tri thức cuộc họp bạn được phép xem',
        trailing: IconButton(onPressed: loadConversations,
          icon: const Icon(Icons.refresh)))),
    Expanded(child: AsyncContent<List<Map<String, dynamic>>>(
      future: future, retry: loadConversations,
      builder: (conversations) => Column(children: [
        Padding(padding: const EdgeInsets.symmetric(horizontal: 18),
          child: Row(children: [
            Expanded(child: Text(conversationId == null
              ? 'Chọn hoặc tạo hội thoại' : 'Hội thoại hiện tại',
              style: const TextStyle(fontWeight: FontWeight.w700))),
            TextButton.icon(onPressed: createConversation,
              icon: const Icon(Icons.add), label: const Text('Tạo mới')),
          ])),
        if (conversationId == null && conversations.isNotEmpty)
          Expanded(child: ListView(padding: const EdgeInsets.all(18),
            children: conversations.map((c) => ContentCard(child: ListTile(
              leading: const Icon(Icons.chat_bubble_outline),
              title: Text(textValue(c['title'], 'Hội thoại')),
              subtitle: Text(dateLabel(c['createdAt'])),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => openConversation(textValue(c['id'])),
            ))).toList()))
        else if (conversationId == null)
          const Expanded(child: Center(child: MessagePanel(
            title: 'Chưa có hội thoại',
            description: 'Tạo một cuộc trò chuyện để bắt đầu truy vấn.')))
        else ...[
          Expanded(child: messages.isEmpty
            ? const Center(child: MessagePanel(
              title: 'Hãy đặt câu hỏi đầu tiên',
              description: 'AI chỉ sử dụng nguồn họp được cấp quyền.'))
            : ListView(controller: scroll, padding: const EdgeInsets.all(18),
              children: messages.map(messageTile).toList())),
          Padding(padding: EdgeInsets.fromLTRB(
            12, 4, 12, MediaQuery.viewInsetsOf(context).bottom + 10),
            child: Row(children: [
              Expanded(child: TextField(
                controller: input, maxLines: 4, minLines: 1,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => ask(),
                decoration: const InputDecoration(hintText: 'Hỏi về cuộc họp của bạn...'))),
              const SizedBox(width: 8),
              IconButton.filled(onPressed: sending ? null : ask,
                icon: sending ? const SizedBox(width: 18, height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.arrow_upward)),
            ])),
        ],
      ]),
    )),
  ]);
}
