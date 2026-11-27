import 'package:flutter/material.dart';

import '../../core/meeting_models.dart';
import '../../core/widgets.dart';
import '../recording/processing_manager.dart';
import '../recording/transcript_review_contract.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

/// This panel acts on the exact processing handoff, not just the current
/// meeting. The app-owned manager retains uncertain operations on tab changes.
class TranscriptAdmissionPanel extends StatelessWidget {
  const TranscriptAdmissionPanel({
    super.key,
    required this.workspace,
    required this.handoff,
    this.onAdmitted,
  });

  final ResultsWorkspaceController workspace;
  final TranscriptReviewHandoff handoff;
  final ValueChanged<TranscriptReviewHandoff>? onAdmitted;

  bool _matchesHandoff(Transcript? transcript) =>
      transcript != null &&
      transcript.meetingId == handoff.meetingId &&
      transcript.processingJobId == handoff.jobId &&
      transcript.sourceMediaId == handoff.sourceMediaId &&
      transcript.finalizedAt != null &&
      const {'READY', 'READY_WITH_WARNINGS'}.contains(transcript.status) &&
      transcript.etag != null &&
      transcript.etag!.isNotEmpty;

  Future<void> _submit(
    BuildContext context,
    TranscriptReviewCommand command,
    Transcript? transcript,
  ) async {
    final epoch = workspace.reviewEpoch;
    try {
      final proof = transcript == null
          ? null
          : TranscriptReviewProof.fromTranscript(
              transcript,
              meetingId: handoff.meetingId,
              jobId: handoff.jobId,
              sourceMediaId: handoff.sourceMediaId!,
            );
      final admitted = await workspace.reviewProcessingTranscript(
        handoff,
        command,
        proof,
        epoch: epoch,
      );
      if (!context.mounted || !workspace.ownsReview(epoch)) return;
      if (admitted) {
        showSuccess(context, 'Core đã tiếp nhận yêu cầu xử lý.');
        onAdmitted?.call(handoff);
      } else {
        showSuccess(
          context,
          'Đã xác nhận transcript. Chọn tiếp tục để xử lý kết quả AI.',
        );
      }
    } catch (error) {
      if (context.mounted && workspace.ownsSession) {
        showFailure(context, error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final manager = workspace.processingManager;
    if (manager == null) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: Listenable.merge([workspace, manager]),
      builder: (context, _) {
        if (!workspace.capabilities.canRead ||
            handoff.meetingId != workspace.meetingId) {
          return const SizedBox.shrink();
        }
        final scope = workspace.sessionScope;
        final operation = manager.reviewOperation(handoff.jobId, scope);
        final busy = manager.reviewBusy(handoff.jobId, scope);
        final transcript = workspace.transcript.data;
        final coverage = workspace.coverage;
        final matchingCoverage =
            transcript != null &&
            (coverage.phase == ResultsResourcePhase.available ||
                coverage.phase == ResultsResourcePhase.empty) &&
            coverage.data?.transcriptId == transcript.id &&
            coverage.data?.transcriptEtag == transcript.etag;
        final sourceCurrent =
            workspace.transcriptIsCurrent &&
            _matchesHandoff(transcript) &&
            matchingCoverage;
        final ready =
            operation?.receipt != null &&
            transcript != null &&
            operation!.proof.matches(transcript);
        final canAct = workspace.canReviewProcessingTranscript && !busy;
        final pending = operation?.pending;
        return ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Duyệt transcript trước khi xử lý AI',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              if (operation?.admitted == true)
                const Text('Core đã xác nhận tiếp nhận yêu cầu xử lý.')
              else if (busy)
                const Text('Đang xác minh thao tác với Core…')
              else if (pending != null)
                const Text(
                  'Chưa xác định kết quả thao tác trước. Chỉ thử lại chính '
                  'yêu cầu đã gửi, không tạo yêu cầu mới.',
                )
              else if (!sourceCurrent)
                const Text(
                  'Cần transcript đã hoàn tất và coverage của đúng tác vụ. '
                  'Làm mới dữ liệu trước khi xác nhận.',
                )
              else if (ready)
                const Text(
                  'Bản sửa đổi hiện tại đã được xác nhận. Bạn có thể '
                  'tiếp tục phân tích cuộc họp.',
                )
              else
                const Text(
                  'Kiểm tra nội dung, đoạn chưa chắc chắn và vùng coverage. '
                  'Xác nhận bản đã xem trước khi tiếp tục phân tích.',
                ),
              if (sourceCurrent &&
                  (transcript!.status == 'READY_WITH_WARNINGS' ||
                      coverage.data!.regions.any(
                        (region) => region.status != 'COVERED',
                      )))
                const Text(
                  'Transcript có cảnh báo. Hãy xem lại các vùng được đánh dấu.',
                ),
              const SizedBox(height: 12),
              if (operation?.admitted == true)
                OutlinedButton(
                  onPressed: onAdmitted == null
                      ? null
                      : () => onAdmitted!(handoff),
                  child: const Text('Xem tiến trình xử lý'),
                )
              else if (pending != null)
                FilledButton(
                  onPressed: canAct
                      ? () => _submit(context, pending, null)
                      : null,
                  child: const Text('Xác minh lại yêu cầu đã gửi'),
                )
              else ...[
                OutlinedButton(
                  onPressed: canAct && sourceCurrent && !ready
                      ? () => _submit(
                          context,
                          TranscriptReviewCommand.acknowledge,
                          transcript,
                        )
                      : null,
                  child: const Text('Xác nhận đã duyệt transcript'),
                ),
                FilledButton(
                  onPressed: canAct && sourceCurrent && ready
                      ? () => _submit(
                          context,
                          TranscriptReviewCommand.admit,
                          transcript,
                        )
                      : null,
                  child: const Text('Tiếp tục phân tích cuộc họp'),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}
