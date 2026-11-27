import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';

import 'media_contracts.dart';

/// Core's correction digest is over exact UTF-8 bytes, not rendered text.
String transcriptCorrectionDigest(Iterable<SpeechSegment> segments) {
  final ordered = segments.toList()
    ..sort((a, b) => a.ordinal.compareTo(b.ordinal));
  final bytes = BytesBuilder(copy: false)
    ..add(utf8.encode('SME-CONTEXTUAL-CORRECTION-V1\u0000'));
  final ordinals = <int>{};
  for (final segment in ordered) {
    final text = utf8.encode(segment.text);
    if (segment.ordinal < 0 ||
        segment.ordinal > 0x7fffffff ||
        !ordinals.add(segment.ordinal) ||
        segment.startMs < 0 ||
        segment.endMs < segment.startMs ||
        text.length > 0x7fffffff) {
      throw const ApiFailure(
        422,
        'DIGEST_INPUT_INVALID',
        'Transcript contains invalid correction evidence.',
      );
    }
    final header = ByteData(24)
      ..setInt32(0, segment.ordinal, Endian.big)
      ..setInt64(4, segment.startMs, Endian.big)
      ..setInt64(12, segment.endMs, Endian.big)
      ..setInt32(20, text.length, Endian.big);
    bytes
      ..add(header.buffer.asUint8List())
      ..add(text);
  }
  return sha256.convert(bytes.takeBytes()).toString();
}

/// Immutable source proof. No transcript text is retained by the operation.
class TranscriptReviewProof {
  TranscriptReviewProof._(
    this.meetingId,
    this.jobId,
    this.sourceMediaId,
    this.transcriptId,
    this.contentRevision,
    this.correctionDigest,
    this.etag,
    this.status,
    this.versionNumber,
    this.finalizedAt,
  );

  factory TranscriptReviewProof.fromTranscript(
    Transcript transcript, {
    required String meetingId,
    required String jobId,
    required String sourceMediaId,
  }) {
    if (transcript.meetingId != meetingId ||
        transcript.processingJobId != jobId ||
        transcript.sourceMediaId != sourceMediaId ||
        transcript.finalizedAt == null ||
        !const {'READY', 'READY_WITH_WARNINGS'}.contains(transcript.status) ||
        transcript.etag == null ||
        transcript.etag!.isEmpty) {
      throw const ApiFailure(
        409,
        'REVIEW_SOURCE_MISMATCH',
        'The finalized transcript does not match the selected processing job.',
      );
    }
    return TranscriptReviewProof._(
      meetingId,
      jobId,
      sourceMediaId,
      transcript.id,
      transcript.contentRevision,
      transcriptCorrectionDigest(transcript.segments),
      transcript.etag!,
      transcript.status,
      transcript.versionNumber,
      transcript.finalizedAt!,
    );
  }

  final String meetingId;
  final String jobId;
  final String sourceMediaId;
  final String transcriptId;
  final int contentRevision;
  final String correctionDigest;
  final String etag;
  final String status;
  final int versionNumber;
  final DateTime finalizedAt;

  bool matches(Transcript transcript) =>
      transcript.meetingId == meetingId &&
      transcript.processingJobId == jobId &&
      transcript.sourceMediaId == sourceMediaId &&
      transcript.id == transcriptId &&
      transcript.contentRevision == contentRevision &&
      transcript.etag == etag &&
      transcript.status == status &&
      transcript.versionNumber == versionNumber &&
      transcript.finalizedAt == finalizedAt;

  bool matchesJob(ProcessingJobRecord job) =>
      job.id == jobId &&
      job.meetingId == meetingId &&
      job.sourceMediaId == sourceMediaId &&
      job.jobType == ProcessingJobType.offlineMeetingProcessing;

  Map<String, dynamic> toJson() => {
    'transcriptId': transcriptId,
    'contentRevision': contentRevision,
    'correctionDigest': correctionDigest,
  };

  /// A proof-specific key is stable even after process death. Core scopes
  /// idempotency by actor/operation/job and coalesces receipts for a proof.
  String key({String? reviewId}) {
    final digest = sha256.convert(
      utf8.encode(
        jsonEncode([
          jobId,
          transcriptId,
          contentRevision,
          correctionDigest,
          reviewId,
        ]),
      ),
    );
    return 'mobile-review-v1-$digest';
  }
}

class TranscriptReviewReceipt {
  const TranscriptReviewReceipt({
    required this.reviewId,
    required this.admitted,
  });

  final String reviewId;
  final bool admitted;

  factory TranscriptReviewReceipt.fromResult(
    ApiResult response,
    TranscriptReviewProof proof,
  ) {
    final raw = response.objectData();
    if (requiredIdentifier(raw, 'processingJobId', response: response) !=
            proof.jobId ||
        requiredIdentifier(raw, 'meetingId', response: response) !=
            proof.meetingId ||
        requiredIdentifier(raw, 'transcriptId', response: response) !=
            proof.transcriptId ||
        requiredInt(raw, 'contentRevision', response: response) !=
            proof.contentRevision ||
        requiredString(raw, 'correctionDigest', response: response) !=
            proof.correctionDigest ||
        requiredString(raw, 'transcriptStatus', response: response) !=
            proof.status) {
      invalidApiData(response: response);
    }
    requiredIdentifier(raw, 'acknowledgedByUserId', response: response);
    requiredTimestamp(raw, 'acknowledgedAt', response: response);
    final admittedAt = optionalTimestamp(raw, 'admittedAt', response: response);
    final admittedBy = optionalIdentifier(
      raw,
      'admittedByUserId',
      response: response,
    );
    if ((admittedAt == null) != (admittedBy == null)) {
      invalidApiData(response: response);
    }
    return TranscriptReviewReceipt(
      reviewId: requiredIdentifier(raw, 'reviewId', response: response),
      admitted: admittedAt != null,
    );
  }
}
