import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/recording/media_contracts.dart';

void main() {
  test('upload intent preserves nullable replay capability fields', () {
    final intent = MediaUploadIntent.fromJson(<String, dynamic>{
      'mediaId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'status': 'AVAILABLE',
      'uploadUrl': null,
      'expiresAt': null,
      'requiredContentType': 'audio/wav',
    });

    expect(intent.status, MediaStatus.available);
    expect(intent.hasUploadCapability, isFalse);
    expect(intent.uploadUrl, isNull);
  });

  test('finalization keeps rejected media as a typed non-success record', () {
    final record = MediaRecord.fromJson(<String, dynamic>{
      'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'meetingId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'sourceType': 'UPLOAD',
      'status': 'REJECTED',
      'originalFilename': 'meeting.wav',
      'contentType': 'audio/wav',
      'sizeBytes': null,
      'durationMs': null,
      'sha256': null,
      'createdAt': '2026-11-24T12:00:00Z',
      'availableAt': null,
      'failureCode': 'MEDIA_FORMAT_UNSUPPORTED',
    });

    expect(record.accepted, isFalse);
    expect(record.rejected, isTrue);
    expect(record.failureCode, 'MEDIA_FORMAT_UNSUPPORTED');
  });

  test(
    'processing jobs accept nullable provenance fields and review state',
    () {
      final job = ProcessingJobRecord.fromJson(<String, dynamic>{
        'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'meetingId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'sourceMediaId': null,
        'jobType': 'DERIVED_STAGE_PROCESSING',
        'status': 'WAITING_FOR_REVIEW',
        'requestedByUserId': null,
        'currentStage': 'DIARIZING',
        'queuedAt': '2026-11-24T12:00:00Z',
        'startedAt': '2026-11-24T12:01:00Z',
        'completedAt': null,
        'errorCode': null,
        'errorSummary': null,
        'warningSummary': 'Review required.',
        'createdAt': '2026-11-24T12:00:00Z',
        'updatedAt': '2026-11-24T12:01:00Z',
        'reprocessOfJobId': null,
        'retryable': false,
        'retryCount': 0,
        'stageRuns': <Map<String, dynamic>>[],
      });

      expect(job.sourceMediaId, isNull);
      expect(job.requestedByUserId, isNull);
      expect(job.isWaitingForReview, isTrue);
      expect(job.status.isSuccessful, isFalse);
    },
  );

  test('invalid media and stage contracts fail closed', () {
    expect(
      () => MediaUploadIntent.fromJson(<String, dynamic>{
        'mediaId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'status': 'PENDING_UPLOAD',
        'uploadUrl': 'https://storage.example.test/object',
        'expiresAt': null,
        'requiredContentType': 'audio/wav',
      }),
      throwsA(isA<ApiFailure>()),
    );
    expect(
      () => ProcessingJobRecord.fromJson(<String, dynamic>{
        'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'meetingId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'sourceMediaId': null,
        'jobType': 'DERIVED_STAGE_PROCESSING',
        'status': 'RUNNING',
        'requestedByUserId': null,
        'currentStage': null,
        'queuedAt': '2026-11-24T12:00:00Z',
        'startedAt': null,
        'completedAt': null,
        'errorCode': null,
        'errorSummary': null,
        'warningSummary': null,
        'createdAt': '2026-11-24T12:00:00Z',
        'updatedAt': '2026-11-24T12:00:00Z',
        'reprocessOfJobId': null,
        'retryable': false,
        'retryCount': 0,
        'stageRuns': <Map<String, dynamic>>[
          <String, dynamic>{
            'id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'stageCode': 'TRANSCRIBING',
            'attemptNumber': 0,
            'status': 'PENDING',
            'providerName': null,
            'modelName': null,
            'startedAt': null,
            'completedAt': null,
            'errorCode': null,
          },
        ],
      }),
      throwsA(isA<ApiFailure>()),
    );
  });
}
