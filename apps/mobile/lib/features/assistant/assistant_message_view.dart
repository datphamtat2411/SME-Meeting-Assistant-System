import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'assistant_models.dart';

class AssistantMessageView extends StatefulWidget {
  const AssistantMessageView({
    super.key,
    required this.message,
    this.onOpenCitation,
  });

  final AssistantMessage message;
  final ValueChanged<AssistantCitation>? onOpenCitation;

  @override
  State<AssistantMessageView> createState() => _AssistantMessageViewState();
}

class _AssistantMessageViewState extends State<AssistantMessageView> {
  String? _selectedCitation;

  @override
  void didUpdateWidget(covariant AssistantMessageView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.message, widget.message)) {
      _selectedCitation = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.message;
    final colors = Theme.of(context).colorScheme;
    final mine = message.role == AssistantMessageRole.user;
    final assistant = message.role == AssistantMessageRole.assistant;
    final hidden =
        message.visibility == AssistantMessageVisibility.sourceUnavailable;
    final time = DateFormat('HH:mm · dd/MM')
        .format(message.createdAt.toLocal());
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620),
        child: Card(
          color: mine ? colors.primaryContainer : colors.surfaceContainerLow,
          margin: EdgeInsets.only(
            left: mine ? 24 : 0,
            right: mine ? 0 : 12,
            bottom: 12,
          ),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (assistant) ...[
                      Icon(Icons.auto_awesome, size: 16, color: colors.primary),
                    ],
                    Text(
                      mine
                          ? 'Bạn'
                          : assistant
                          ? 'Trợ lý AI'
                          : 'Hệ thống',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    Text(time, style: Theme.of(context).textTheme.labelSmall),
                  ],
                ),
                const SizedBox(height: 10),
                if (hidden)
                  const Text(
                    'Câu trả lời không còn khả dụng vì nguồn đã thay đổi '
                    'hoặc không còn được phép truy cập.',
                  )
                else ...[
                  if (assistant && message.answerStatus != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        _answerLabel(message.answerStatus!),
                        style: Theme.of(context).textTheme.labelLarge?.copyWith(
                          color:
                              message.answerStatus ==
                                  AssistantAnswerStatus.grounded
                              ? colors.primary
                              : colors.onSurfaceVariant,
                        ),
                      ),
                    ),
                  SelectableText(
                    message.content ?? '',
                    style: TextStyle(
                      color: mine
                          ? colors.onPrimaryContainer
                          : colors.onSurface,
                    ),
                  ),
                  if (message.claims.any(
                    (claim) => claim.support != AssistantClaimSupport.supported,
                  ))
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Row(
                        children: [
                          Icon(Icons.info_outline, color: colors.error),
                          const SizedBox(width: 8),
                          const Expanded(
                            child: Text(
                              'Có thông tin chưa đủ bằng chứng hoặc xung đột. '
                              'Xem chi tiết bên dưới.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (message.claims.isNotEmpty || message.citations.isNotEmpty)
                    ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      childrenPadding: EdgeInsets.zero,
                      title: Text(
                        'Bằng chứng · ${message.citations.length} nguồn',
                      ),
                      children: [
                        for (final claim in message.claims)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Text(
                                  _supportLabel(claim.support),
                                  style: Theme.of(context)
                                      .textTheme
                                      .labelMedium,
                                ),
                                SelectableText(claim.text),
                                if (claim.citationIds.isNotEmpty)
                                  Wrap(
                                    spacing: 6,
                                    children: [
                                      for (final id in claim.citationIds)
                                        ActionChip(
                                          label: Text(id),
                                          onPressed: () => setState(
                                            () => _selectedCitation = id,
                                          ),
                                        ),
                                    ],
                                  ),
                              ],
                            ),
                          ),
                        const Divider(),
                        for (final citation in message.citations)
                          ListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            selected: _selectedCitation == citation.citationId,
                            leading: const Icon(Icons.description_outlined),
                            title: Text(
                              '${citation.citationId} · '
                              '${_sourceLabel(citation.sourceType)}',
                            ),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Phiên bản ${citation.sourceRevision}'),
                                if (_selectedCitation == citation.citationId)
                                  Text(
                                    'Hỗ trợ: ${citation.claimIds.join(', ')}',
                                  ),
                              ],
                            ),
                            onTap: () => setState(
                              () => _selectedCitation = citation.citationId,
                            ),
                            trailing: widget.onOpenCitation == null
                                ? null
                                : IconButton(
                                    tooltip: 'Mở nguồn tham chiếu',
                                    onPressed: () =>
                                        widget.onOpenCitation!(citation),
                                    icon: const Icon(Icons.open_in_new),
                                  ),
                          ),
                      ],
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String _answerLabel(AssistantAnswerStatus status) => switch (status) {
  AssistantAnswerStatus.grounded => 'Có bằng chứng hỗ trợ',
  AssistantAnswerStatus.partial =>
    'Bằng chứng chỉ hỗ trợ một phần hoặc xung đột',
  AssistantAnswerStatus.insufficientEvidence => 'Không đủ bằng chứng',
  AssistantAnswerStatus.failed => 'Không thể tạo câu trả lời',
};

String _supportLabel(AssistantClaimSupport support) => switch (support) {
  AssistantClaimSupport.supported => 'Có nguồn hỗ trợ',
  AssistantClaimSupport.unsupported => 'Chưa có đủ bằng chứng',
  AssistantClaimSupport.conflicted => 'Nguồn có xung đột',
};

String _sourceLabel(AssistantSourceType source) => switch (source) {
  AssistantSourceType.transcript => 'Bản chép lời',
  AssistantSourceType.summary => 'Tóm tắt',
  AssistantSourceType.decision => 'Quyết định',
  AssistantSourceType.actionItem => 'Công việc',
};
