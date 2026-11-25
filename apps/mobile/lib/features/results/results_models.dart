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
  }) : coverage = coverage != null &&
               coverage.transcriptId == transcript.id &&
               coverage.transcriptEtag == transcript.etag
           ? coverage
           : null,
       _speakers = speakers != null &&
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

  List<TranscriptCoverageRegion> get reviewRegions => coverage?.regions
      .where((region) => region.status != 'COVERED' || region.recovered)
      .toList(growable: false) ?? const [];
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

/// Canonical minutes projections do not share mutation models with Decisions
/// or Action Items; they intentionally carry no client-side business authority.
class MinutesDecision {
  const MinutesDecision({
    required this.id,
    required this.content,
    required this.status,
    required this.confirmedByUserId,
    required this.confirmedAt,
    required this.sourceType,
  });
  final String id, content, status, sourceType;
  final String? confirmedByUserId;
  final DateTime? confirmedAt;
  factory MinutesDecision.fromJson(
    Map<String, dynamic> raw,
    ApiResult response,
  ) {
    final status = requiredString(raw, 'status', response: response);
    if (status != 'CONFIRMED') invalidApiData(response: response);
    return MinutesDecision(
      id: requiredIdentifier(raw, 'id', response: response),
      content: requiredString(raw, 'content', response: response),
      status: status,
      sourceType: requiredString(raw, 'sourceType', response: response),
      confirmedByUserId: optionalIdentifier(
        raw,
        'confirmedByUserId',
        response: response,
      ),
      confirmedAt: optionalTimestamp(raw, 'confirmedAt', response: response),
    );
  }
}

class MinutesAction {
  const MinutesAction({
    required this.id,
    required this.title,
    required this.details,
    required this.status,
    required this.assigneeUserId,
    required this.dueDate,
    required this.sourceType,
  });
  final String id, title, status, sourceType;
  final String? details, assigneeUserId, dueDate;
  factory MinutesAction.fromJson(Map<String, dynamic> raw, ApiResult response) {
    final status = requiredString(raw, 'status', response: response);
    if (status == 'PROPOSED' || status == 'REJECTED')
      invalidApiData(response: response);
    return MinutesAction(
      id: requiredIdentifier(raw, 'id', response: response),
      title: requiredString(raw, 'title', response: response),
      details: optionalString(raw, 'details', response: response),
      status: status,
      sourceType: requiredString(raw, 'sourceType', response: response),
      assigneeUserId: optionalIdentifier(
        raw,
        'assigneeUserId',
        response: response,
      ),
      dueDate: optionalDateOnly(raw, 'dueDate', response: response),
    );
  }
}

class MeetingMinutes {
  const MeetingMinutes({
    required this.completeness,
    required this.assembledAt,
    required this.summaryContent,
    required this.confirmedDecisions,
    required this.officialActionItems,
    required this.transcriptAvailability,
    required this.transcriptStatus,
    required this.warnings,
    required this.meetingId,
    required this.schemaVersion,
    required this.sourceFingerprint,
  });

  final String completeness;
  final String meetingId;
  final int schemaVersion;
  final String sourceFingerprint;
  final DateTime? assembledAt;
  final String? summaryContent;
  final List<MinutesDecision> confirmedDecisions;
  final List<MinutesAction> officialActionItems;
  final String transcriptAvailability;
  final String? transcriptStatus;
  final List<String> warnings;

  factory MeetingMinutes.fromResult(ApiResult response) {
    final raw = response.objectData();
    final transcript = requiredObject(raw, 'transcript', response: response);
    return MeetingMinutes(
      meetingId: requiredIdentifier(
        requiredObject(raw, 'meeting', response: response),
        'id',
        response: response,
      ),
      schemaVersion: requiredInt(
        raw,
        'schemaVersion',
        response: response,
        minimum: 1,
      ),
      sourceFingerprint: requiredString(
        raw,
        'sourceFingerprint',
        response: response,
        nonEmpty: true,
      ),
      completeness: requiredString(
        raw,
        'completeness',
        response: response,
        nonEmpty: true,
      ),
      assembledAt: optionalTimestamp(raw, 'assembledAt', response: response),
      summaryContent: _nestedOptionalString(
        raw,
        'summary',
        'content',
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
      transcriptAvailability: requiredString(
        transcript,
        'availability',
        response: response,
        nonEmpty: true,
      ),
      transcriptStatus: optionalString(
        transcript,
        'status',
        response: response,
      ),
      warnings: _strings(raw, 'warnings', response),
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

String? _nestedOptionalString(
  Map<String, dynamic> raw,
  String objectField,
  String field,
  ApiResult response,
) {
  final object = raw[objectField];
  if (object == null) return null;
  return optionalString(
    requiredObject(raw, objectField, response: response),
    field,
    response: response,
  );
}
