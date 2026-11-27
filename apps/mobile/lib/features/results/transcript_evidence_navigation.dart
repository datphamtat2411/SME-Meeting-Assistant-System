import '../../core/meeting_models.dart';
import 'results_workspace_controller.dart';
import 'results_models.dart';

class TranscriptEvidenceReference {
  const TranscriptEvidenceReference({
    required this.transcriptId,
    required this.segmentId,
    this.contentRevision,
    this.transcriptEtag,
  });

  final String transcriptId;
  final String segmentId;
  final int? contentRevision;
  final String? transcriptEtag;
}

enum TranscriptEvidenceNavigationStatus {
  opened,
  missing,
  obsolete,
  forbidden,
  unavailable,
}

class TranscriptEvidenceNavigationResult {
  const TranscriptEvidenceNavigationResult({
    required this.status,
    this.segment,
  });

  final TranscriptEvidenceNavigationStatus status;
  final SpeechSegment? segment;
}

/// Stable integration boundary for Decision Review and other future consumers.
/// It never substitutes a segment by matching text or approximate timestamps.
class TranscriptEvidenceNavigationBoundary {
  const TranscriptEvidenceNavigationBoundary(this.workspace);

  final ResultsWorkspaceController workspace;

  Future<TranscriptEvidenceNavigationResult> locate(
    TranscriptEvidenceReference reference,
  ) async {
    final epoch = workspace.readEpoch;
    if (!workspace.ownsRead(epoch)) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.forbidden,
      );
    }
    await workspace.loadTranscript(force: true);
    if (!workspace.ownsRead(epoch)) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.forbidden,
      );
    }
    if (!workspace.transcriptIsCurrent) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.unavailable,
      );
    }
    final transcript = workspace.transcript.data;
    if (transcript == null ||
        transcript.id != reference.transcriptId ||
        reference.contentRevision != null &&
            reference.contentRevision != transcript.contentRevision ||
        reference.transcriptEtag != null &&
            reference.transcriptEtag != transcript.etag) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.obsolete,
      );
    }
    SpeechSegment? segment;
    for (final candidate in transcript.segments) {
      if (candidate.id == reference.segmentId) {
        segment = candidate;
        break;
      }
    }
    if (segment != null &&
        !workspace.focusTranscriptSegment(
          TranscriptFocusRequest(
            transcriptId: transcript.id,
            transcriptEtag: transcript.etag,
            segmentId: segment.id,
            readEpoch: epoch,
          ),
        )) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.obsolete,
      );
    }
    return TranscriptEvidenceNavigationResult(
      status: segment == null
          ? TranscriptEvidenceNavigationStatus.missing
          : TranscriptEvidenceNavigationStatus.opened,
      segment: segment,
    );
  }
}
