import '../../core/api_client.dart';
import '../../core/api_model_validation.dart';
import '../../core/meeting_models.dart';

enum ResultsResourcePhase {
  uninitialized,
  loading,
  available,
  empty,
  notReady,
  refreshing,
  failed,
  forbidden,
  verifyingAuthorization,
  authorizationVerificationFailed,
}

class ResultsResource<T> {
  const ResultsResource({
    this.phase = ResultsResourcePhase.uninitialized,
    this.data,
    this.failure,
    this.generation = 0,
  });

  final ResultsResourcePhase phase;
  final T? data;
  final Object? failure;
  final int generation;

  bool get hasData =>
      data != null &&
      (phase == ResultsResourcePhase.available ||
          phase == ResultsResourcePhase.empty ||
          phase == ResultsResourcePhase.refreshing ||
          phase == ResultsResourcePhase.failed);

  ResultsResource<T> copyWith({
    ResultsResourcePhase? phase,
    T? data,
    Object? failure,
    int? generation,
    bool clearFailure = false,
    bool clearData = false,
  }) => ResultsResource<T>(
    phase: phase ?? this.phase,
    data: clearData || phase == ResultsResourcePhase.forbidden
        ? null
        : data ?? this.data,
    failure: clearFailure ? null : failure ?? this.failure,
    generation: generation ?? this.generation,
  );
}

class SpeakerCluster {
  const SpeakerCluster({
    required this.id,
    required this.label,
    required this.userId,
    required this.displayName,
  });

  final String id;
  final String label;
  final String? userId;
  final String? displayName;

  factory SpeakerCluster.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => SpeakerCluster(
    id: requiredIdentifier(raw, 'id', response: response),
    label: requiredString(raw, 'label', response: response, nonEmpty: true),
    userId: optionalIdentifier(raw, 'userId', response: response),
    displayName: optionalString(raw, 'displayName', response: response),
  );
}

/// Read representations bracketed by the same canonical transcript ETag.
class SpeakerReviewSnapshot {
  const SpeakerReviewSnapshot({
    required this.transcriptId,
    required this.etag,
    required this.clusters,
  });
  final String transcriptId;
  final String etag;
  final List<SpeakerCluster> clusters;
}

class SpeakerCandidate {
  const SpeakerCandidate(this.id, this.displayName);
  final String id;
  final String displayName;
}

class TranscriptCoverageRegion {
  const TranscriptCoverageRegion({
    required this.id,
    required this.startMs,
    required this.endMs,
    required this.status,
    required this.recovered,
    required this.retryCount,
  });

  final String id;
  final int startMs;
  final int endMs;
  final String status;
  final bool recovered;
  final int retryCount;

  factory TranscriptCoverageRegion.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final startMs = requiredInt(raw, 'startMs', response: response);
    final endMs = requiredInt(raw, 'endMs', response: response);
    final status = requiredString(
      raw,
      'coverageStatus',
      response: response,
      nonEmpty: true,
    );
    if (endMs < startMs ||
        !const {'COVERED', 'SUSPICIOUS', 'UNRESOLVED_ERROR'}.contains(status)) {
      invalidApiData(response: response);
    }
    return TranscriptCoverageRegion(
      id: requiredIdentifier(raw, 'id', response: response),
      startMs: startMs,
      endMs: endMs,
      status: status,
      recovered: requiredBool(raw, 'recovered', response: response),
      retryCount: requiredInt(
        raw,
        'retryCount',
        response: response,
        minimum: 0,
      ),
    );
  }
}

/// Coverage is a separate server representation. The bracketed transcript
/// identity prevents a coverage response from being shown beside a newer
/// transcript publication.
class TranscriptCoverage {
  const TranscriptCoverage({
    required this.transcriptId,
    required this.transcriptEtag,
    required this.regions,
  });

  final String transcriptId;
  final String transcriptEtag;
  final List<TranscriptCoverageRegion> regions;
}

/// A presentation projection may only combine representations that were
/// bracketed by the same server-issued transcript identity and token.
class TranscriptReviewProjection {
  TranscriptReviewProjection(
    this.transcript, {
    TranscriptCoverage? coverage,
    SpeakerReviewSnapshot? speakers,
  }) : coverage =
           coverage != null &&
               coverage.transcriptId == transcript.id &&
               coverage.transcriptEtag == transcript.etag
           ? coverage
           : null,
       _speakers =
           speakers != null &&
               speakers.transcriptId == transcript.id &&
               speakers.etag == transcript.etag
           ? {for (final cluster in speakers.clusters) cluster.id: cluster}
           : const <String, SpeakerCluster>{};

  final Transcript transcript;
  final TranscriptCoverage? coverage;
  final Map<String, SpeakerCluster> _speakers;

  String speakerName(SpeechSegment segment) {
    final cluster = _speakers[segment.speakerClusterId];
    return cluster?.displayName ??
        cluster?.label ??
        segment.speakerLabel ??
        'Chưa xác định';
  }

  String speakerKey(SpeechSegment segment) {
    final cluster = _speakers[segment.speakerClusterId];
    final userId = cluster?.userId;
    if (userId != null) return 'user:$userId';
    return 'cluster:${segment.speakerClusterId ?? segment.speakerLabel ?? ''}';
  }

  List<TranscriptCoverageRegion> get reviewRegions =>
      coverage?.regions
          .where((region) => region.status != 'COVERED' || region.recovered)
          .toList(growable: false) ??
      const [];
}

class TranscriptFocusRequest {
  const TranscriptFocusRequest({
    required this.transcriptId,
    required this.transcriptEtag,
    required this.segmentId,
    required this.readEpoch,
  });

  final String transcriptId;
  final String? transcriptEtag;
  final String segmentId;
  final int readEpoch;
}

class ResultsSummary {
  const ResultsSummary({
    required this.id,
    required this.meetingId,
    required this.versionNumber,
    required this.content,
    required this.sourceType,
    required this.qualityStatus,
    required this.processingJobId,
    required this.transcriptId,
    required this.contentRevision,
    required this.isStale,
    required this.createdAt,
    required this.createdByUserId,
    required this.aiWarnings,
    required this.etag,
    this.aiProducer,
  });

  final String id;
  final String meetingId;
  final int versionNumber;
  final String content;
  final String sourceType;
  final String qualityStatus;
  final String? processingJobId;
  final String? transcriptId;
  final int? contentRevision;
  final bool isStale;
  final DateTime createdAt;
  final String? createdByUserId;
  final List<String> aiWarnings;
  final String etag;
  final Map<String, dynamic>? aiProducer;

  factory ResultsSummary.fromResult(ApiResult response) {
    final raw = response.objectData();
    return ResultsSummary(
      id: requiredIdentifier(raw, 'id', response: response),
      meetingId: requiredIdentifier(raw, 'meetingId', response: response),
      versionNumber: requiredInt(
        raw,
        'versionNumber',
        response: response,
        minimum: 1,
      ),
      content: requiredString(raw, 'content', response: response),
      sourceType: requiredString(
        raw,
        'sourceType',
        response: response,
        nonEmpty: true,
      ),
      qualityStatus: requiredString(
        raw,
        'qualityStatus',
        response: response,
        nonEmpty: true,
      ),
      processingJobId: optionalIdentifier(
        raw,
        'processingJobId',
        response: response,
      ),
      transcriptId: optionalIdentifier(raw, 'transcriptId', response: response),
      contentRevision: optionalInt(raw, 'contentRevision', response: response),
      isStale: requiredBool(raw, 'isStale', response: response),
      createdAt: requiredTimestamp(raw, 'createdAt', response: response),
      createdByUserId: optionalIdentifier(
        raw,
        'createdByUserId',
        response: response,
      ),
      aiWarnings: _strings(raw, 'aiWarnings', response),
      etag: _requiredEtag(response),
      aiProducer: optionalObject(raw, 'aiProducer', response: response),
    );
  }
}

class SummaryVersion {
  const SummaryVersion({
    required this.id,
    required this.versionNumber,
    required this.content,
    required this.sourceType,
    required this.qualityStatus,
    required this.isStale,
    required this.isCurrent,
    required this.createdAt,
    this.meetingId,
    this.transcriptId,
    this.contentRevision,
    this.processingJobId,
    this.createdByUserId,
    this.aiWarnings = const [],
    this.aiProducer,
  });

  final String id;
  final int versionNumber;
  final String content;
  final String sourceType;
  final String qualityStatus;
  final bool isStale;
  final bool isCurrent;
  final DateTime createdAt;
  final String? meetingId, transcriptId, processingJobId, createdByUserId;
  final int? contentRevision;
  final List<String> aiWarnings;
  final Map<String, dynamic>? aiProducer;

  factory SummaryVersion.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => SummaryVersion(
    id: requiredIdentifier(raw, 'id', response: response),
    versionNumber: requiredInt(
      raw,
      'versionNumber',
      response: response,
      minimum: 1,
    ),
    content: requiredString(raw, 'content', response: response),
    sourceType: requiredString(
      raw,
      'sourceType',
      response: response,
      nonEmpty: true,
    ),
    qualityStatus: requiredString(
      raw,
      'qualityStatus',
      response: response,
      nonEmpty: true,
    ),
    isStale: requiredBool(raw, 'isStale', response: response),
    isCurrent: requiredBool(raw, 'isCurrent', response: response),
    createdAt: requiredTimestamp(raw, 'createdAt', response: response),
    meetingId: optionalIdentifier(raw, 'meetingId', response: response),
    transcriptId: optionalIdentifier(raw, 'transcriptId', response: response),
    contentRevision: optionalInt(raw, 'contentRevision', response: response),
    processingJobId: optionalIdentifier(
      raw,
      'processingJobId',
      response: response,
    ),
    createdByUserId: optionalIdentifier(
      raw,
      'createdByUserId',
      response: response,
    ),
    aiWarnings: raw['aiWarnings'] == null
        ? const []
        : _strings(raw, 'aiWarnings', response),
    aiProducer: optionalObject(raw, 'aiProducer', response: response),
  );
}

/// Canonical Minutes is a read-only projection. It deliberately does not
/// reuse mutable Decision or Action Item command models.
class MinutesMeeting {
  const MinutesMeeting({
    required this.id,
    required this.title,
    required this.description,
    required this.organizerUserId,
    required this.status,
    required this.scheduledStartAt,
    required this.scheduledEndAt,
    required this.startedAt,
    required this.endedAt,
  });

  final String id;
  final String title;
  final String? description;
  final String organizerUserId;
  final String status;
  final DateTime? scheduledStartAt;
  final DateTime? scheduledEndAt;
  final DateTime? startedAt;
  final DateTime? endedAt;

  factory MinutesMeeting.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final value = MinutesMeeting(
      id: requiredIdentifier(raw, 'id', response: response),
      title: requiredString(raw, 'title', response: response),
      description: optionalString(raw, 'description', response: response),
      organizerUserId: requiredIdentifier(
        raw,
        'organizerUserId',
        response: response,
      ),
      status: requiredString(raw, 'status', response: response),
      scheduledStartAt: optionalTimestamp(
        raw,
        'scheduledStartAt',
        response: response,
      ),
      scheduledEndAt: optionalTimestamp(
        raw,
        'scheduledEndAt',
        response: response,
      ),
      startedAt: optionalTimestamp(raw, 'startedAt', response: response),
      endedAt: optionalTimestamp(raw, 'endedAt', response: response),
    );
    if (!const {'DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CANCELLED'}
        .contains(value.status)) {
      invalidApiData(response: response);
    }
    return value;
  }
}

class MinutesSummary {
  const MinutesSummary({
    required this.availability,
    required this.id,
    required this.versionNumber,
    required this.content,
    required this.sourceType,
    required this.qualityStatus,
    required this.transcriptId,
    required this.contentRevision,
    required this.selectionEpoch,
    required this.isStale,
    required this.aiWarnings,
  });

  final String availability;
  final String? id;
  final int? versionNumber;
  final String? content;
  final String? sourceType;
  final String? qualityStatus;
  final String? transcriptId;
  final int? contentRevision;
  final int selectionEpoch;
  final bool isStale;
  final List<String> aiWarnings;

  factory MinutesSummary.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final value = MinutesSummary(
      availability: requiredString(raw, 'availability', response: response),
      id: optionalIdentifier(raw, 'id', response: response),
      versionNumber: optionalInt(raw, 'versionNumber', response: response),
      content: optionalString(raw, 'content', response: response),
      sourceType: optionalString(raw, 'sourceType', response: response),
      qualityStatus: optionalString(raw, 'qualityStatus', response: response),
      transcriptId: optionalIdentifier(raw, 'transcriptId', response: response),
      contentRevision: optionalInt(raw, 'contentRevision', response: response),
      selectionEpoch: requiredInt(raw, 'selectionEpoch', response: response),
      isStale: requiredBool(raw, 'isStale', response: response),
      aiWarnings: _strings(raw, 'aiWarnings', response),
    );
    if (!const {'NOT_AVAILABLE', 'AVAILABLE', 'NEEDS_REVIEW'}.contains(
          value.availability,
        ) ||
        (value.availability == 'NOT_AVAILABLE'
            ? value.id != null || value.content != null
            : value.id == null ||
                  value.content == null ||
                  value.versionNumber == null ||
                  value.sourceType == null ||
                  value.qualityStatus == null)) {
      invalidApiData(response: response);
    }
    return value;
  }
}

class MinutesDecision {
  const MinutesDecision({
    required this.id,
    required this.content,
    required this.status,
    required this.sourceType,
    required this.transcriptId,
    required this.contentRevision,
    required this.isStale,
    required this.version,
    required this.confirmedByUserId,
    required this.confirmedAt,
    required this.evidenceSegmentIds,
    required this.aiUncertainty,
    required this.aiWarnings,
  });

  final String id;
  final String content;
  final String status;
  final String sourceType;
  final String? transcriptId;
  final int? contentRevision;
  final bool isStale;
  final int version;
  final String? confirmedByUserId;
  final DateTime? confirmedAt;
  final List<String> evidenceSegmentIds;
  final String? aiUncertainty;
  final List<String> aiWarnings;

  factory MinutesDecision.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final value = MinutesDecision(
      id: requiredIdentifier(raw, 'id', response: response),
      content: requiredString(raw, 'content', response: response),
      status: requiredString(raw, 'status', response: response),
      sourceType: requiredString(raw, 'sourceType', response: response),
      transcriptId: optionalIdentifier(raw, 'transcriptId', response: response),
      contentRevision: optionalInt(raw, 'contentRevision', response: response),
      isStale: requiredBool(raw, 'isStale', response: response),
      version: requiredInt(raw, 'version', response: response),
      confirmedByUserId: optionalIdentifier(
        raw,
        'confirmedByUserId',
        response: response,
      ),
      confirmedAt: optionalTimestamp(raw, 'confirmedAt', response: response),
      evidenceSegmentIds: _strings(raw, 'evidenceSegmentIds', response),
      aiUncertainty: optionalString(raw, 'aiUncertainty', response: response),
      aiWarnings: _strings(raw, 'aiWarnings', response),
    );
    if (value.status != 'CONFIRMED') invalidApiData(response: response);
    return value;
  }
}

class MinutesAction {
  const MinutesAction({
    required this.id,
    required this.title,
    required this.details,
    required this.status,
    required this.sourceType,
    required this.assigneeUserId,
    required this.dueDate,
    required this.version,
    required this.createdAt,
    required this.confirmedByUserId,
    required this.confirmedAt,
  });

  final String id;
  final String title;
  final String? details;
  final String status;
  final String sourceType;
  final String? assigneeUserId;
  final String? dueDate;
  final int version;
  final DateTime createdAt;
  final String? confirmedByUserId;
  final DateTime? confirmedAt;

  factory MinutesAction.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final value = MinutesAction(
      id: requiredIdentifier(raw, 'id', response: response),
      title: requiredString(raw, 'title', response: response),
      details: optionalString(raw, 'details', response: response),
      status: requiredString(raw, 'status', response: response),
      sourceType: requiredString(raw, 'sourceType', response: response),
      assigneeUserId: optionalIdentifier(
        raw,
        'assigneeUserId',
        response: response,
      ),
      dueDate: optionalDateOnly(raw, 'dueDate', response: response),
      version: requiredInt(raw, 'version', response: response),
      createdAt: requiredTimestamp(raw, 'createdAt', response: response),
      confirmedByUserId: optionalIdentifier(
        raw,
        'confirmedByUserId',
        response: response,
      ),
      confirmedAt: optionalTimestamp(raw, 'confirmedAt', response: response),
    );
    if (!const {'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'}.contains(
          value.status,
        ) ||
        (value.sourceType != 'MANUAL' && value.confirmedByUserId == null)) {
      invalidApiData(response: response);
    }
    return value;
  }
}

class MinutesTranscript {
  const MinutesTranscript({
    required this.availability,
    required this.id,
    required this.processingJobId,
    required this.versionNumber,
    required this.languageCode,
    required this.status,
    required this.contentRevision,
    required this.durationMs,
    required this.suspiciousSegments,
    required this.unresolvedSegments,
    required this.unresolvedCoverageRegions,
  });

  final String availability;
  final String? id;
  final String? processingJobId;
  final int? versionNumber;
  final String? languageCode;
  final String? status;
  final int? contentRevision;
  final int? durationMs;
  final int suspiciousSegments;
  final int unresolvedSegments;
  final int unresolvedCoverageRegions;

  factory MinutesTranscript.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final value = MinutesTranscript(
      availability: requiredString(raw, 'availability', response: response),
      id: optionalIdentifier(raw, 'id', response: response),
      processingJobId: optionalIdentifier(
        raw,
        'processingJobId',
        response: response,
      ),
      versionNumber: optionalInt(raw, 'versionNumber', response: response),
      languageCode: optionalString(raw, 'languageCode', response: response),
      status: optionalString(raw, 'status', response: response),
      contentRevision: optionalInt(raw, 'contentRevision', response: response),
      durationMs: optionalInt(raw, 'durationMs', response: response),
      suspiciousSegments: requiredInt(
        raw,
        'suspiciousSegments',
        response: response,
      ),
      unresolvedSegments: requiredInt(
        raw,
        'unresolvedSegments',
        response: response,
      ),
      unresolvedCoverageRegions: requiredInt(
        raw,
        'unresolvedCoverageRegions',
        response: response,
      ),
    );
    if (!const {
      'NOT_AVAILABLE',
      'AVAILABLE',
      'PROCESSING',
      'FAILED',
      'NEEDS_REVIEW',
    }.contains(value.availability)) {
      invalidApiData(response: response);
    }
    if (value.availability == 'NOT_AVAILABLE'
        ? value.id != null || value.status != null
        : value.id == null || value.status == null) {
      invalidApiData(response: response);
    }
    return value;
  }
}

class MeetingMinutes {
  const MeetingMinutes({
    required this.completeness,
    required this.assembledAt,
    required this.meeting,
    required this.summary,
    required this.confirmedDecisions,
    required this.officialActionItems,
    required this.transcript,
    required this.warnings,
    required this.schemaVersion,
    required this.sourceFingerprint,
    required this.proposalsIncluded,
  });

  final String completeness;
  final int schemaVersion;
  final String sourceFingerprint;
  final DateTime assembledAt;
  final MinutesMeeting meeting;
  final MinutesSummary summary;
  final List<MinutesDecision> confirmedDecisions;
  final List<MinutesAction> officialActionItems;
  final MinutesTranscript transcript;
  final List<String> warnings;
  final bool proposalsIncluded;

  String get meetingId => meeting.id;
  String? get summaryContent => summary.content;
  String get transcriptAvailability => transcript.availability;
  String? get transcriptStatus => transcript.status;

  factory MeetingMinutes.fromResult(ApiResult response) {
    final raw = response.objectData();
    final schemaVersion = requiredInt(raw, 'schemaVersion', response: response);
    final completeness = requiredString(raw, 'completeness', response: response);
    final proposalsIncluded = requiredBool(
      raw,
      'proposalsIncluded',
      response: response,
    );
    if (schemaVersion != 1 ||
        proposalsIncluded ||
        !const {'COMPLETE', 'PARTIAL', 'NEEDS_REVIEW'}.contains(completeness)) {
      invalidApiData(response: response);
    }
    return MeetingMinutes(
      meeting: MinutesMeeting.fromJson(
        requiredObject(raw, 'meeting', response: response),
        response,
      ),
      schemaVersion: schemaVersion,
      sourceFingerprint: requiredString(
        raw,
        'sourceFingerprint',
        response: response,
        nonEmpty: true,
      ),
      completeness: completeness,
      assembledAt: requiredTimestamp(raw, 'assembledAt', response: response),
      summary: MinutesSummary.fromJson(
        requiredObject(raw, 'summary', response: response),
        response,
      ),
      confirmedDecisions: List.unmodifiable(
        _nestedObjects(
          raw,
          'confirmedDecisions',
          response,
        ).map((item) => MinutesDecision.fromJson(item, response)),
      ),
      officialActionItems: List.unmodifiable(
        _nestedObjects(
          raw,
          'officialActionItems',
          response,
        ).map((item) => MinutesAction.fromJson(item, response)),
      ),
      transcript: MinutesTranscript.fromJson(
        requiredObject(raw, 'transcript', response: response),
        response,
      ),
      warnings: _strings(raw, 'warnings', response),
      proposalsIncluded: proposalsIncluded,
    );
  }
}

String _requiredEtag(ApiResult response) {
  final value = response.etag;
  if (value == null ||
      value.trim().isEmpty ||
      value.contains('\r') ||
      value.contains('\n')) {
    throw response.invalidDataFailure();
  }
  return value;
}

List<String> _strings(
  Map<String, dynamic> raw,
  String field,
  ApiResult? response,
) {
  final value = raw[field];
  if (value is! List || value.any((item) => item is! String)) {
    invalidApiData(response: response);
  }
  return List<String>.unmodifiable(value.cast<String>());
}

List<Map<String, dynamic>> _nestedObjects(
  Map<String, dynamic> raw,
  String field,
  ApiResult response,
) => List<Map<String, dynamic>>.unmodifiable(
  requireJsonObjectArray(raw[field], response: response),
);

