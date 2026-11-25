import '../../core/api_client.dart';
import '../../core/api_model_validation.dart';

enum ResultsResourcePhase {
  uninitialized,
  loading,
  available,
  empty,
  notReady,
  refreshing,
  failed,
  forbidden,
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
  });

  final String id;
  final int versionNumber;
  final String content;
  final String sourceType;
  final String qualityStatus;
  final bool isStale;
  final bool isCurrent;
  final DateTime createdAt;

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
  );
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
  });

  final String completeness;
  final DateTime? assembledAt;
  final String? summaryContent;
  final List<Map<String, dynamic>> confirmedDecisions;
  final List<Map<String, dynamic>> officialActionItems;
  final String transcriptAvailability;
  final String? transcriptStatus;
  final List<String> warnings;

  factory MeetingMinutes.fromResult(ApiResult response) {
    final raw = response.objectData();
    final transcript = requiredObject(raw, 'transcript', response: response);
    return MeetingMinutes(
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
      confirmedDecisions: _nestedObjects(raw, 'confirmedDecisions', response),
      officialActionItems: _nestedObjects(raw, 'officialActionItems', response),
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
  ApiResult response,
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
