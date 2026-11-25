import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/command_actions.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

class SpeakerMappingPanel extends StatefulWidget {
  const SpeakerMappingPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<SpeakerMappingPanel> createState() => _SpeakerMappingPanelState();
}

class _SpeakerMappingPanelState extends State<SpeakerMappingPanel> {
  bool busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(widget.workspace.loadSpeakers());
    unawaited(widget.workspace.loadTranscript());
  }

  Future<void> assign(String clusterId, String? userId) async {
    if (busy) return;
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () => widget.workspace.mapSpeaker(clusterId, userId),
      successText: 'Đã cập nhật người nói.',
    );
    if (mounted) setState(() => busy = false);
  }

  Future<void> choose(String clusterId) async {
    final search = TextEditingController();
    List<Map<String, dynamic>> found = const [];
    final user = await showDialog<String>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, update) => AlertDialog(
          title: const Text('Gán người nói'),
          content: SizedBox(
            width: 430,
            height: 320,
            child: Column(
              children: [
                TextField(
                  controller: search,
                  decoration: const InputDecoration(
                    labelText: 'Tìm tên/email (Enter để tìm)',
                  ),
                  onSubmitted: (value) async {
                    if (value.trim().length < 2) return;
                    try {
                      final items = await widget.workspace.meetingCandidates(
                        value.trim(),
                      );
                      if (dialog.mounted) update(() => found = items);
                    } catch (error) {
                      if (dialog.mounted) showFailure(dialog, error);
                    }
                  },
                ),
                Expanded(
                  child: ListView(
                    children: found
                        .map(
                          (person) => ListTile(
                            title: Text(textValue(person['displayName'])),
                            subtitle: Text(textValue(person['email'])),
                            onTap: () =>
                                Navigator.pop(dialog, textValue(person['id'])),
                          ),
                        )
                        .toList(),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Hủy'),
            ),
          ],
        ),
      ),
    );
    search.dispose();
    if (user != null && mounted) await assign(clusterId, user);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.speakers;
      final items = resource.data;
      if (items == null) {
        return MessagePanel(
          title: resource.phase == ResultsResourcePhase.forbidden
              ? 'Bạn không có quyền xem kết quả này'
              : 'Chưa có nhóm người nói',
          onRetry: resource.phase == ResultsResourcePhase.failed
              ? () => unawaited(widget.workspace.loadSpeakers(force: true))
              : null,
        );
      }
      return ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const SectionHeading(
            'Nhận diện người nói',
            subtitle: 'Có thể hiệu chỉnh nhãn do AI nhận dạng.',
          ),
          if (items.isEmpty)
            const MessagePanel(title: 'Chưa có nhóm người nói'),
          ...items.map(
            (entry) => ContentCard(
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(
                  child: Icon(Icons.record_voice_over_outlined),
                ),
                title: Text(entry.label),
                subtitle: Text(entry.displayName ?? 'Chưa gán nhân viên'),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      onPressed:
                          busy || !widget.workspace.capabilities.canMutate
                          ? null
                          : () => choose(entry.id),
                      icon: const Icon(Icons.person_add_outlined),
                      tooltip: 'Gán người nói',
                    ),
                    if (entry.userId != null)
                      IconButton(
                        onPressed:
                            busy || !widget.workspace.capabilities.canMutate
                            ? null
                            : () => assign(entry.id, null),
                        icon: const Icon(Icons.link_off_outlined),
                        tooltip: 'Bỏ gán',
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      );
    },
  );
}
