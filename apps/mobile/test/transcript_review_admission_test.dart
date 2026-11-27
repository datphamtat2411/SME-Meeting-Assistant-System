import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/transcript_review_contract.dart';

import 'support/meeting_test_support.dart';

const _job = '11111111-1111-4111-8111-111111111111';
const _media = '22222222-2222-4222-8222-222222222222';
const _transcript = '33333333-3333-4333-8333-333333333333';
const _review = '44444444-4444-4444-8444-444444444444';

SpeechSegment _segment(int ordinal, int start, int end, String text) =>
    SpeechSegment(
      id: 'segment-$ordinal',
      ordinal: ordinal,
      text: text,
      startMs: start,
      endMs: end,
      speakerLabel: null,
      speakerClusterId: null,
      quality: 'ACCEPTED',
      version: 0,
      etag: '"opaque-segment"',
    );

Transcript _source({int revision = 1, String text = 'Xin chào'}) => Transcript(
  id: _transcript,
  meetingId: testMeetingId,
  sourceMediaId: _media,
  processingJobId: _job,
  versionNumber: 1,
  languageCode: 'vi',
  status: 'READY',
  durationMs: 3000,
  finalizedAt: DateTime.utc(2026, 11, 24),
  contentRevision: revision,
  segments: [_segment(1, 0, 1500, text)],
  etag: '"opaque-transcript-$revision"',
);

TranscriptReviewProof _proof(Transcript transcript) =>
    TranscriptReviewProof.fromTranscript(
      transcript,
      meetingId: testMeetingId,
      jobId: _job,
      sourceMediaId: _media,
    );

Map<String, dynamic> _jobJson(bool admitted) => {
  'id': _job,
  'meetingId': testMeetingId,
  'sourceMediaId': _media,
  'jobType': 'OFFLINE_MEETING_PROCESSING',
  'status': admitted ? 'RUNNING' : 'WAITING_FOR_REVIEW',
  'requestedByUserId': testUserId,
  'currentStage': null,
  'queuedAt': '2026-11-24T12:00:00Z',
  'startedAt': '2026-11-24T12:01:00Z',
  'completedAt': null,
  'errorCode': null,
  'errorSummary': null,
  'warningSummary': null,
  'createdAt': '2026-11-24T12:00:00Z',
  'updatedAt': '2026-11-24T12:01:00Z',
  'reprocessOfJobId': null,
  'retryable': false,
  'retryCount': 0,
  'stageRuns': <Map<String, dynamic>>[],
};

Map<String, dynamic> _receipt(Map<String, dynamic> proof) => {
  ...proof,
  'reviewId': _review,
  'processingJobId': _job,
  'meetingId': testMeetingId,
  'transcriptStatus': 'READY',
  'acknowledgedByUserId': testUserId,
  'acknowledgedAt': '2026-11-24T12:01:00Z',
  'admittedByUserId': null,
  'admittedAt': null,
};

void main() {
  test('correction digest agrees with Web and Core UTF-8 golden fixtures', () {
    expect(
      transcriptCorrectionDigest([]),
      'da5f8cd6ead91181a26a8c323f078baf716dea5c8c0f7c9b4341b9b172b34545',
    );
    expect(
      transcriptCorrectionDigest([
        _segment(2, 2000, 3000, 'Nội dung\ncuộc họp'),
        _segment(1, 0, 1500, 'Xin chào'),
      ]),
      'b31710a4f182b4314b8c5b180ff84423b77a8a4034070d8dd6887da5dac45901',
    );
    expect(
      transcriptCorrectionDigest([
        _segment(0, 0, 1, 'é'),
        _segment(1, 1, 2, '😊'),
      ]),
      '667e307590a35367ba147201a22d71ffd049be5e4b56501fab4332a99798f957',
    );
    expect(
      () => transcriptCorrectionDigest([
        _segment(1, 0, 1, 'A'),
        _segment(1, 1, 2, 'B'),
      ]),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('proof and stable replay keys bind source and command', () {
    final original = _proof(_source());
    final same = _proof(_source());
    final corrected = _proof(_source(revision: 2, text: 'Đã sửa'));
    expect(original.key(), same.key());
    expect(original.key(), isNot(corrected.key()));
    expect(original.key(), isNot(original.key(reviewId: _review)));
    expect(original.matches(_source(revision: 2)), isFalse);
    expect(
      () => TranscriptReviewProof.fromTranscript(
        _source(),
        meetingId: testMeetingId,
        jobId: _review,
        sourceMediaId: _media,
      ),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('acknowledgement is explicit; stale proof is blocked; ambiguous admission replays exact intent', () async {
    var current = _source();
    var admitted = false;
    var loseResponse = true;
    final acknowledgements = <Map<String, dynamic>>[];
    final admissions = <Map<String, dynamic>>[];
    final keys = <String?>[];
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/transcript-review/acknowledge')) {
        final body = decodeRequestBody(request);
        acknowledgements.add(body);
        return meetingApiSuccess(_receipt(body));
      }
      if (path.endsWith('/meeting-intelligence/admit')) {
        admissions.add(decodeRequestBody(request));
        keys.add(request.headers['Idempotency-Key']);
        admitted = true;
        if (loseResponse) {
          loseResponse = false;
          return meetingApiFailure(503, 'TEMPORARILY_UNAVAILABLE');
        }
        return meetingApiSuccess(_jobJson(true), status: 202);
      }
      if (path.endsWith('/processing-jobs/$_job')) {
        return meetingApiSuccess(_jobJson(admitted));
      }
      if (path.endsWith('/processing-jobs')) {
        return meetingApiSuccess([_jobJson(admitted)]);
      }
      if (path.endsWith('/media')) {
        return meetingApiSuccess(<dynamic>[]);
      }
      throw StateError('Unexpected request: $path');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final scope = api.requireAuthenticatedSessionScope();
    final manager = ProcessingManager(
      api: api,
      mediaRepository: MediaRepository(api: api),
      processingRepository: ProcessingRepository(api: api),
      localMedia: LocalMediaRepository.lazyDefault(),
    );
    addTearDown(() {
      manager.dispose();
      api.dispose();
    });
    const handoff = TranscriptReviewHandoff(
      meetingId: testMeetingId,
      jobId: _job,
      sourceMediaId: _media,
    );
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: testUserId,
      meeting: Meeting.fromJson(meetingTestJson()),
    );
    Future<bool> send(
      TranscriptReviewCommand command,
      TranscriptReviewProof? proof,
    ) => manager.reviewTranscript(
      handoff: handoff,
      scope: scope,
      command: command,
      displayedProof: proof,
      readCurrentTranscript: () async => current,
      stillAuthorized: () => true,
      capabilities: capabilities,
    );

    final first = _proof(current);
    expect(await send(TranscriptReviewCommand.acknowledge, first), isFalse);
    expect(acknowledgements, [first.toJson()]);
    expect(admissions, isEmpty);
    current = _source(revision: 2, text: 'Đã sửa');
    await expectLater(
      send(TranscriptReviewCommand.admit, first),
      throwsA(isA<ApiFailure>()),
    );
    expect(admissions, isEmpty);

    final second = _proof(current);
    expect(await send(TranscriptReviewCommand.acknowledge, second), isFalse);
    await expectLater(
      send(TranscriptReviewCommand.admit, second),
      throwsA(isA<ApiFailure>()),
    );
    expect(
      manager.reviewOperation(_job, scope)?.pending,
      TranscriptReviewCommand.admit,
    );
    current = _source(revision: 3, text: 'Sửa từ Web');
    expect(await send(TranscriptReviewCommand.admit, null), isTrue);
    expect(admissions, [
      {...second.toJson(), 'reviewId': _review},
      {...second.toJson(), 'reviewId': _review},
    ]);
    expect(keys, [
      second.key(reviewId: _review),
      second.key(reviewId: _review),
    ]);
    expect(manager.reviewOperation(_job, scope)?.admitted, isTrue);
  });

  test('wrong acknowledgement identity is an uncertain mutation', () async {
    final api = createMeetingTestApi(
      MeetingTestHttpClient((request) async {
        final body = decodeRequestBody(request);
        return meetingApiSuccess({
          ..._receipt(body),
          'processingJobId': _review,
        });
      }),
    );
    await signInMeetingTestApi(api);
    addTearDown(api.dispose);
    final repository = ProcessingRepository(api: api);
    await expectLater(
      repository.acknowledgeReview(
        _proof(_source()),
        sessionScope: api.requireAuthenticatedSessionScope(),
      ),
      throwsA(
        isA<MediaRepositoryFailure>().having(
          (failure) => failure.mutationOutcome,
          'mutation outcome',
          MediaMutationOutcome.unknown,
        ),
      ),
    );
  });
}
