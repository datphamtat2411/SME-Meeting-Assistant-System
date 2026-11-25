import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';

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
  }

  Future<void> assign(SpeakerReviewSnapshot snapshot, String clusterId,
      String? userId, int epoch) async {
    if (busy) return;
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () => widget.workspace.mapSpeaker(snapshot, clusterId, userId, epoch: epoch),
      successText: 'Đã cập nhật người nói.',
    );
    if (mounted) setState(() => busy = false);
  }

  Future<void> choose(SpeakerReviewSnapshot snapshot, String clusterId) async {
    final epoch = widget.workspace.reviewEpoch;
    final search = TextEditingController();
    List<SpeakerCandidate> found = const [];
    var searchGeneration = 0;
    final user = await showResultsReviewDialog<String>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
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
                    labelText: 'Tìm thành viên cuộc họp (Enter để tìm)',
                  ),
                  onSubmitted: (value) async {
                    final generation = ++searchGeneration;
                    try {
                      final items = await widget.workspace.meetingCandidates(
                        value.trim(), epoch: epoch,
                      );
                      if (dialog.mounted && generation == searchGeneration &&
                          widget.workspace.ownsReview(epoch)) {
                        update(() => found = items);
                      }
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
                            title: Text(person.displayName),
                            onTap: () =>
                                Navigator.pop(dialog, person.id),
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
    if (user != null && mounted) await assign(snapshot, clusterId, user, epoch);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.speakers;
      final snapshot = resource.data;
      final items = snapshot?.clusters;
      if (items == null || snapshot == null) {
        return resultsResourceMessage(
          resource, label: 'Nhóm người nói',
          onRetry: () => widget.workspace.loadSpeakers(force: true),
        );
      }
      return ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const SectionHeading(
            'Nhận diện người nói',
            subtitle: 'Có thể hiệu chỉnh nhãn do AI nhận dạng.',
          ),
          resultsRefreshNotice(resource, () => widget.workspace.loadSpeakers(force: true)),
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
                          busy || widget.workspace.mutationBusy(ResultsMutationGroup.transcript) || !widget.workspace.capabilities.canMutate
                          ? null
                          : () => choose(snapshot, entry.id),
                      icon: const Icon(Icons.person_add_outlined),
                      tooltip: 'Gán người nói',
                    ),
                    if (entry.userId != null)
                      IconButton(
                        onPressed:
                            busy || widget.workspace.mutationBusy(ResultsMutationGroup.transcript) || !widget.workspace.capabilities.canMutate
                            ? null
                            : () => assign(snapshot, entry.id, null, widget.workspace.reviewEpoch),
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
