import '../../core/meeting_models.dart';
import 'results_workspace_controller.dart';

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

enum TranscriptEvidenceNavigationStatus { opened, missing, obsolete, forbidden }

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
    if (!workspace.capabilities.canRead || !workspace.ownsSession) {
      return const TranscriptEvidenceNavigationResult(
        status: TranscriptEvidenceNavigationStatus.forbidden,
      );
    }
    await workspace.loadTranscript();
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
    return TranscriptEvidenceNavigationResult(
      status: segment == null
          ? TranscriptEvidenceNavigationStatus.missing
          : TranscriptEvidenceNavigationStatus.opened,
      segment: segment,
    );
  }
}
