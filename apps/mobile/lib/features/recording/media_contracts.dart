import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';

/// The source values accepted by the Core media admission endpoint.
enum MediaSourceType {
  upload('UPLOAD'),
  recording('RECORDING');

  const MediaSourceType(this.wireValue);

  final String wireValue;

  static MediaSourceType fromWireValue(String value, {ApiResult? response}) {
    for (final candidate in MediaSourceType.values) {
      if (candidate.wireValue == value) return candidate;
    }
    invalidApiData(response: response);
  }
}

enum MediaStatus {
  pendingUpload('PENDING_UPLOAD'),
  available('AVAILABLE'),
  rejected('REJECTED'),
  failed('FAILED');

  const MediaStatus(this.wireValue);

  final String wireValue;

  static MediaStatus fromWireValue(String value, {ApiResult? response}) {
    for (final candidate in MediaStatus.values) {
      if (candidate.wireValue == value) return candidate;
    }
    invalidApiData(response: response);
  }

  bool get isAccepted => this == MediaStatus.available;
  bool get isTerminal => this != MediaStatus.pendingUpload;
}

enum ProcessingJobType {
  offlineMeetingProcessing('OFFLINE_MEETING_PROCESSING'),
  derivedStageProcessing('DERIVED_STAGE_PROCESSING');

  const ProcessingJobType(this.wireValue);

  final String wireValue;

  static ProcessingJobType fromWireValue(String value, {ApiResult? response}) {
    for (final candidate in ProcessingJobType.values) {
      if (candidate.wireValue == value) return candidate;
    }
    invalidApiData(response: response);
  }
}

/// The Core API job lifecycle is intentionally not collapsed into a boolean
/// "complete" flag. In particular, review is a human checkpoint, not success.
enum ProcessingJobStatus {
  pending('PENDING'),
  queued('QUEUED'),
  running('RUNNING'),
  waitingForReview('WAITING_FOR_REVIEW'),
  completed('COMPLETED'),
  completedWithWarnings('COMPLETED_WITH_WARNINGS'),
  failed('FAILED'),
  cancelled('CANCELLED');

  const ProcessingJobStatus(this.wireValue);

  final String wireValue;

  static ProcessingJobStatus fromWireValue(
    String value, {
    ApiResult? response,
  }) {
    for (final candidate in ProcessingJobStatus.values) {
      if (candidate.wireValue == value) return candidate;
    }
    invalidApiData(response: response);
  }

  bool get isHumanReviewCheckpoint =>
      this == ProcessingJobStatus.waitingForReview;

  bool get isSuccessful =>
      this == ProcessingJobStatus.completed ||
      this == ProcessingJobStatus.completedWithWarnings;

  bool get isTerminal =>
      isSuccessful ||
      this == ProcessingJobStatus.failed ||
      this == ProcessingJobStatus.cancelled;
}

enum ProcessingStageStatus {
  pending('PENDING'),
  running('RUNNING'),
  succeeded('SUCCEEDED'),
  succeededWithWarning('SUCCEEDED_WITH_WARNING'),
  failed('FAILED'),
  skipped('SKIPPED'),
  cancelled('CANCELLED');

  const ProcessingStageStatus(this.wireValue);

  final String wireValue;

  static ProcessingStageStatus fromWireValue(
    String value, {
    ApiResult? response,
  }) {
    for (final candidate in ProcessingStageStatus.values) {
      if (candidate.wireValue == value) return candidate;
    }
    invalidApiData(response: response);
  }
}

class MediaUploadRequest {
  MediaUploadRequest({
    required this.sourceType,
    required this.originalFilename,
    required this.contentType,
    required this.expectedSizeBytes,
  }) {
    if (originalFilename.trim().isEmpty ||
        originalFilename.length > 512 ||
        originalFilename.contains('\u0000') ||
        originalFilename.contains('\r') ||
        originalFilename.contains('\n')) {
      throw ArgumentError.value(
        originalFilename,
        'originalFilename',
        'A filename is required.',
      );
    }
    if (contentType.trim().isEmpty || _containsControl(contentType)) {
      throw ArgumentError.value(
        contentType,
        'contentType',
        'A safe content type is required.',
      );
    }
    if (expectedSizeBytes <= 0) {
      throw ArgumentError.value(
        expectedSizeBytes,
        'expectedSizeBytes',
        'The expected size must be positive.',
      );
    }
  }

  final MediaSourceType sourceType;
  final String originalFilename;
  final String contentType;
  final int expectedSizeBytes;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'sourceType': sourceType.wireValue,
    'originalFilename': originalFilename,
    'contentType': contentType,
    'expectedSizeBytes': expectedSizeBytes,
  };
}

class MediaUploadIntent {
  const MediaUploadIntent({
    required this.mediaId,
    required this.status,
    required this.uploadUrl,
    required this.expiresAt,
    required this.requiredContentType,
  });

  final String mediaId;
  final MediaStatus status;
  final String? uploadUrl;
  final DateTime? expiresAt;
  final String requiredContentType;

  bool get hasUploadCapability =>
      status == MediaStatus.pendingUpload &&
      uploadUrl != null &&
      uploadUrl!.isNotEmpty;

  /// A replay may identify an existing media record without minting another
  /// object-storage capability. The repository deliberately returns that
  /// state instead of manufacturing a URL or treating it as malformed.
  factory MediaUploadIntent.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final uploadUrl = _optionalNonEmptyString(
      raw,
      'uploadUrl',
      response: response,
    );
    final expiresAt = optionalTimestamp(raw, 'expiresAt', response: response);
    if ((uploadUrl == null) != (expiresAt == null)) {
      invalidApiData(response: response);
    }
    return MediaUploadIntent(
      mediaId: requiredIdentifier(raw, 'mediaId', response: response),
      status: MediaStatus.fromWireValue(
        requiredString(raw, 'status', response: response, nonEmpty: true),
        response: response,
      ),
      uploadUrl: uploadUrl,
      expiresAt: expiresAt,
      requiredContentType: requiredString(
        raw,
        'requiredContentType',
        response: response,
        nonEmpty: true,
      ),
    );
  }
}

class MediaRecord {
  const MediaRecord({
    required this.id,
    required this.meetingId,
    required this.sourceType,
    required this.status,
    required this.originalFilename,
    required this.contentType,
    required this.sizeBytes,
    required this.durationMs,
    required this.sha256,
    required this.createdAt,
    required this.availableAt,
    required this.failureCode,
  });

  final String id;
  final String meetingId;
  final MediaSourceType sourceType;
  final MediaStatus status;
  final String originalFilename;
  final String contentType;
  final int? sizeBytes;
  final int? durationMs;
  final String? sha256;
  final DateTime createdAt;
  final DateTime? availableAt;
  final String? failureCode;

  bool get accepted => status == MediaStatus.available;
  bool get rejected => status == MediaStatus.rejected;
  bool get failed => status == MediaStatus.failed;

  factory MediaRecord.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final status = MediaStatus.fromWireValue(
      requiredString(raw, 'status', response: response, nonEmpty: true),
      response: response,
    );
    final sizeBytes = optionalInt(
      raw,
      'sizeBytes',
      response: response,
      minimum: 0,
    );
    final durationMs = optionalInt(
      raw,
      'durationMs',
      response: response,
      minimum: 0,
    );
    final sha256 = _optionalSha256(raw, response: response);
    final availableAt = optionalTimestamp(
      raw,
      'availableAt',
      response: response,
    );
    if (status == MediaStatus.available &&
        (sizeBytes == null ||
            sizeBytes <= 0 ||
            durationMs == null ||
            durationMs <= 0 ||
            availableAt == null)) {
      invalidApiData(response: response);
    }
    if (status != MediaStatus.available && availableAt != null) {
      // The backend only assigns availability when it accepts the object.
      invalidApiData(response: response);
    }
    return MediaRecord(
      id: requiredIdentifier(raw, 'id', response: response),
      meetingId: requiredIdentifier(raw, 'meetingId', response: response),
      sourceType: MediaSourceType.fromWireValue(
        requiredString(raw, 'sourceType', response: response, nonEmpty: true),
        response: response,
      ),
      status: status,
      originalFilename: requiredString(
        raw,
        'originalFilename',
        response: response,
        nonEmpty: true,
      ),
      contentType: requiredString(
        raw,
        'contentType',
        response: response,
        nonEmpty: true,
      ),
      sizeBytes: sizeBytes,
      durationMs: durationMs,
      sha256: sha256,
      createdAt: requiredTimestamp(raw, 'createdAt', response: response),
      availableAt: availableAt,
      failureCode: _optionalNonEmptyString(
        raw,
        'failureCode',
        response: response,
      ),
    );
  }
}

class MediaAccessCapability {
  const MediaAccessCapability({required this.url, required this.expiresAt});

  final String url;
  final DateTime expiresAt;

  factory MediaAccessCapability.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final url = requiredString(raw, 'url', response: response, nonEmpty: true);
    final parsed = Uri.tryParse(url);
    if (parsed == null ||
        !parsed.isAbsolute ||
        parsed.scheme.toLowerCase() != 'https' ||
        parsed.host.isEmpty ||
        parsed.userInfo.isNotEmpty ||
        parsed.hasFragment) {
      invalidApiData(response: response);
    }
    return MediaAccessCapability(
      url: url,
      expiresAt: requiredTimestamp(raw, 'expiresAt', response: response),
    );
  }
}

class ProcessingStageRecord {
  const ProcessingStageRecord({
    required this.id,
    required this.stageCode,
    required this.attemptNumber,
    required this.status,
    required this.providerName,
    required this.modelName,
    required this.startedAt,
    required this.completedAt,
    required this.errorCode,
  });

  final String id;
  final String stageCode;
  final int attemptNumber;
  final ProcessingStageStatus status;
  final String? providerName;
  final String? modelName;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final String? errorCode;

  factory ProcessingStageRecord.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final startedAt = optionalTimestamp(raw, 'startedAt', response: response);
    final completedAt = optionalTimestamp(
      raw,
      'completedAt',
      response: response,
    );
    if (startedAt != null &&
        completedAt != null &&
        completedAt.isBefore(startedAt)) {
      invalidApiData(response: response);
    }
    return ProcessingStageRecord(
      id: requiredIdentifier(raw, 'id', response: response),
      stageCode: requiredString(
        raw,
        'stageCode',
        response: response,
        nonEmpty: true,
      ),
      attemptNumber: requiredInt(
        raw,
        'attemptNumber',
        response: response,
        minimum: 1,
      ),
      status: ProcessingStageStatus.fromWireValue(
        requiredString(raw, 'status', response: response, nonEmpty: true),
        response: response,
      ),
      providerName: optionalString(raw, 'providerName', response: response),
      modelName: optionalString(raw, 'modelName', response: response),
      startedAt: startedAt,
      completedAt: completedAt,
      errorCode: _optionalNonEmptyString(raw, 'errorCode', response: response),
    );
  }
}

class ProcessingJobRecord {
  const ProcessingJobRecord({
    required this.id,
    required this.meetingId,
    required this.sourceMediaId,
    required this.jobType,
    required this.status,
    required this.requestedByUserId,
    required this.currentStage,
    required this.warningSummary,
    required this.errorSummary,
    required this.errorCode,
    required this.retryable,
    required this.retryCount,
    required this.reprocessOfJobId,
    required this.queuedAt,
    required this.startedAt,
    required this.completedAt,
    required this.createdAt,
    required this.updatedAt,
    required this.stageRuns,
  });

  final String id;
  final String meetingId;
  final String? sourceMediaId;
  final ProcessingJobType jobType;
  final ProcessingJobStatus status;
  final String? requestedByUserId;
  final String? currentStage;
  final String? warningSummary;
  final String? errorSummary;
  final String? errorCode;
  final bool retryable;
  final int retryCount;
  final String? reprocessOfJobId;
  final DateTime? queuedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<ProcessingStageRecord> stageRuns;

  bool get isWaitingForReview => status.isHumanReviewCheckpoint;
  bool get isSuccessful => status.isSuccessful;

  factory ProcessingJobRecord.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final queuedAt = optionalTimestamp(raw, 'queuedAt', response: response);
    final startedAt = optionalTimestamp(raw, 'startedAt', response: response);
    final completedAt = optionalTimestamp(
      raw,
      'completedAt',
      response: response,
    );
    final createdAt = requiredTimestamp(raw, 'createdAt', response: response);
    final updatedAt = requiredTimestamp(raw, 'updatedAt', response: response);
    if ((queuedAt != null &&
            startedAt != null &&
            startedAt.isBefore(queuedAt)) ||
        (completedAt != null &&
            startedAt != null &&
            completedAt.isBefore(startedAt)) ||
        updatedAt.isBefore(createdAt)) {
      invalidApiData(response: response);
    }
    final stages = requireJsonObjectArray(
      raw['stageRuns'],
      response: response,
    ).map((stage) => ProcessingStageRecord.fromJson(stage, response: response));
    return ProcessingJobRecord(
      id: requiredIdentifier(raw, 'id', response: response),
      meetingId: requiredIdentifier(raw, 'meetingId', response: response),
      sourceMediaId: optionalIdentifier(
        raw,
        'sourceMediaId',
        response: response,
      ),
      jobType: ProcessingJobType.fromWireValue(
        requiredString(raw, 'jobType', response: response, nonEmpty: true),
        response: response,
      ),
      status: ProcessingJobStatus.fromWireValue(
        requiredString(raw, 'status', response: response, nonEmpty: true),
        response: response,
      ),
      requestedByUserId: optionalIdentifier(
        raw,
        'requestedByUserId',
        response: response,
      ),
      currentStage: optionalString(raw, 'currentStage', response: response),
      warningSummary: optionalString(raw, 'warningSummary', response: response),
      errorSummary: optionalString(raw, 'errorSummary', response: response),
      errorCode: _optionalNonEmptyString(raw, 'errorCode', response: response),
      retryable: requiredBool(raw, 'retryable', response: response),
      retryCount: requiredInt(
        raw,
        'retryCount',
        response: response,
        minimum: 0,
      ),
      reprocessOfJobId: optionalIdentifier(
        raw,
        'reprocessOfJobId',
        response: response,
      ),
      queuedAt: queuedAt,
      startedAt: startedAt,
      completedAt: completedAt,
      createdAt: createdAt,
      updatedAt: updatedAt,
      stageRuns: List<ProcessingStageRecord>.unmodifiable(stages),
    );
  }
}

String? _optionalNonEmptyString(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  final value = raw[field];
  if (value is! String || value.trim().isEmpty) {
    invalidApiData(response: response);
  }
  return value;
}

bool _containsControl(String value) => value.codeUnits.any(
  (unit) => unit < 0x20 || (unit >= 0x7f && unit <= 0x9f),
);

String? _optionalSha256(Map<String, dynamic> raw, {ApiResult? response}) {
  final value = _optionalNonEmptyString(raw, 'sha256', response: response);
  if (value != null && !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(value)) {
    invalidApiData(response: response);
  }
  return value;
}
