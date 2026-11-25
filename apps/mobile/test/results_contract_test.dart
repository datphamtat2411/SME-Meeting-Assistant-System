import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';

Map<String, dynamic> minutesFixture() => {
  'completeness': 'PARTIAL',
  'meeting': {
    'id': 'meeting-1',
    'title': 'Planning',
    'organizerUserId': 'user-1',
    'status': 'ENDED',
  },
  'schemaVersion': 1,
  'sourceFingerprint': 'server-fingerprint',
  'assembledAt': '2026-11-23T10:00:00Z',
  'summary': {
    'availability': 'NOT_AVAILABLE',
    'selectionEpoch': 0,
    'isStale': false,
    'aiWarnings': <String>[],
  },
  'confirmedDecisions': <dynamic>[],
  'officialActionItems': <dynamic>[],
  'transcript': {
    'availability': 'NOT_AVAILABLE',
    'suspiciousSegments': 0,
    'unresolvedSegments': 0,
    'unresolvedCoverageRegions': 0,
  },
  'warnings': <String>['TRANSCRIPT_NOT_AVAILABLE'],
  'proposalsIncluded': false,
};

void main() {
  test(
    'transcript projection rejects unrelated coverage and speaker snapshots',
    () {
      const segment = SpeechSegment(
        id: 'segment-1',
        ordinal: 0,
        text: 'Hello',
        startMs: 0,
        endMs: 1000,
        speakerLabel: 'SPEAKER_01',
        speakerClusterId: 'cluster-1',
        quality: 'ACCEPTED',
        version: 1,
        etag: '"segment"',
      );
      const transcript = Transcript(
        id: 'transcript-1',
        meetingId: 'meeting-1',
        sourceMediaId: null,
        processingJobId: null,
        versionNumber: 1,
        languageCode: 'vi',
        status: 'READY',
        durationMs: 1000,
        finalizedAt: null,
        contentRevision: 1,
        segments: [segment],
        etag: '"current"',
      );
      const cluster = SpeakerCluster(
        id: 'cluster-1',
        label: 'SPEAKER_01',
        userId: 'user-1',
        displayName: 'Nguyễn Văn A',
      );
      final stale = TranscriptReviewProjection(
        transcript,
        coverage: const TranscriptCoverage(
          transcriptId: 'transcript-1',
          transcriptEtag: '"old"',
          regions: [],
        ),
        speakers: const SpeakerReviewSnapshot(
          transcriptId: 'transcript-1',
          etag: '"old"',
          clusters: [cluster],
        ),
      );
      expect(stale.coverage, isNull);
      expect(stale.speakerName(segment), 'SPEAKER_01');
      final current = TranscriptReviewProjection(
        transcript,
        coverage: const TranscriptCoverage(
          transcriptId: 'transcript-1',
          transcriptEtag: '"current"',
          regions: [],
        ),
        speakers: const SpeakerReviewSnapshot(
          transcriptId: 'transcript-1',
          etag: '"current"',
          clusters: [cluster],
        ),
      );
      expect(current.coverage!.regions, isEmpty);
      expect(current.speakerName(segment), 'Nguyễn Văn A');
      expect(current.speakerKey(segment), 'user:user-1');
    },
  );

  test('forbidden resource cannot retain previous protected data', () {
    const resource = ResultsResource<String>(
      phase: ResultsResourcePhase.available,
      data: 'protected',
    );
    final denied = resource.copyWith(phase: ResultsResourcePhase.forbidden);
    expect(denied.data, isNull);
    expect(denied.hasData, isFalse);
  });

  test('empty collection remains a reusable loaded resource', () {
    const resource = ResultsResource<List<String>>(
      phase: ResultsResourcePhase.empty,
      data: [],
    );
    expect(resource.hasData, isTrue);
  });

  test('canonical minutes can exist without a transcript', () {
    final minutes = MeetingMinutes.fromResult(
      ApiResult(
        minutesFixture(),
        const {},
        null,
      ),
    );
    expect(minutes.transcriptStatus, isNull);
    expect(minutes.transcriptAvailability, 'NOT_AVAILABLE');
  });

  test('minutes reject incompatible schema and unofficial content', () {
    final incompatible = minutesFixture()..['schemaVersion'] = 2;
    expect(
      () => MeetingMinutes.fromResult(ApiResult(incompatible, const {}, null)),
      throwsA(isA<ApiFailure>()),
    );
    final proposed = minutesFixture()
      ..['confirmedDecisions'] = [
        {
          'id': 'decision-1',
          'content': 'Proposal',
          'status': 'PROPOSED',
          'sourceType': 'AI_EXTRACTED',
          'isStale': false,
          'version': 0,
          'evidenceSegmentIds': <String>[],
          'aiWarnings': <String>[],
        },
      ];
    expect(
      () => MeetingMinutes.fromResult(ApiResult(proposed, const {}, null)),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('minutes preserve official stale decisions and date-only due dates', () {
    final raw = minutesFixture()
      ..['confirmedDecisions'] = [
        {
          'id': 'decision-1',
          'content': 'Confirmed',
          'status': 'CONFIRMED',
          'sourceType': 'AI_EXTRACTED',
          'isStale': true,
          'version': 2,
          'transcriptId': 'transcript-1',
          'contentRevision': 1,
          'evidenceSegmentIds': ['segment-1'],
          'aiWarnings': <String>['SOURCE_STALE'],
        },
      ]
      ..['officialActionItems'] = [
        {
          'id': 'action-1',
          'title': 'Follow up',
          'status': 'OPEN',
          'sourceType': 'MANUAL',
          'dueDate': '2026-11-30',
          'version': 0,
          'createdAt': '2026-11-23T10:00:00Z',
        },
      ];
    final minutes = MeetingMinutes.fromResult(ApiResult(raw, const {}, null));
    expect(minutes.confirmedDecisions.single.status, 'CONFIRMED');
    expect(minutes.confirmedDecisions.single.isStale, isTrue);
    expect(minutes.confirmedDecisions.single.evidenceSegmentIds, ['segment-1']);
    expect(minutes.officialActionItems.single.dueDate, '2026-11-30');
    expect(minutes.meeting.title, 'Planning');
    expect(minutes.summary.availability, 'NOT_AVAILABLE');
  });

  test('older item representations remain read-only without a token', () {
    final segment = SpeechSegment.fromJson({
      'id': 'segment-1',
      'ordinal': 0,
      'startMs': 0,
      'endMs': 1000,
      'text': 'Hello',
      'qualityStatus': 'ACCEPTED',
      'version': 0,
    });
    expect(segment.etag, isNull);
  });

  test('keeps item and header concurrency tokens opaque', () {
    final response = ApiResult(
      {
        'id': 'summary-1',
        'meetingId': 'meeting-1',
        'versionNumber': 2,
        'content': 'Summary',
        'sourceType': 'HUMAN_EDIT',
        'qualityStatus': 'CONFIRMED',
        'processingJobId': null,
        'transcriptId': null,
        'contentRevision': null,
        'isStale': false,
        'createdAt': '2026-11-23T10:00:00Z',
        'createdByUserId': 'user-1',
        'aiWarnings': <String>[],
      },
      const {},
      '"sum-server-token"',
    );

    final summary = ResultsSummary.fromResult(response);

    expect(summary.etag, '"sum-server-token"');
    expect(summary.versionNumber, 2);
  });

  test('rejects a summary response without its server token', () {
    expect(
      () => ResultsSummary.fromResult(
        ApiResult(
          {
            'id': 'summary-1',
            'meetingId': 'meeting-1',
            'versionNumber': 2,
            'content': 'Summary',
            'sourceType': 'HUMAN_EDIT',
            'qualityStatus': 'CONFIRMED',
            'processingJobId': null,
            'transcriptId': null,
            'contentRevision': null,
            'isStale': false,
            'createdAt': '2026-11-23T10:00:00Z',
            'createdByUserId': 'user-1',
            'aiWarnings': <String>[],
          },
          const {},
          null,
        ),
      ),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('parses item-level tokens for transcript segments and decisions', () {
    final segment = SpeechSegment.fromJson({
      'id': 'segment-1',
      'ordinal': 0,
      'startMs': 0,
      'endMs': 1000,
      'text': 'Hello',
      'qualityStatus': 'ACCEPTED',
      'speakerClusterId': null,
      'speakerLabel': null,
      'version': 4,
      'etag': '"s-server-token"',
    });
    final decision = MeetingDecision.fromJson({
      'id': 'decision-1',
      'meetingId': 'meeting-1',
      'content': 'Decision',
      'status': 'CONFIRMED',
      'version': 4,
      'isStale': false,
      'createdAt': '2026-11-23T10:00:00Z',
      'confirmedAt': null,
      'rejectedAt': null,
      'etag': '"dec-server-token"',
    });

    expect(segment.etag, '"s-server-token"');
    expect(decision.etag, '"dec-server-token"');
  });

  test('parses transcript coverage evidence and summary provenance', () {
    final coverage = TranscriptCoverageRegion.fromJson({
      'id': 'coverage-1',
      'startMs': 100,
      'endMs': 900,
      'coverageStatus': 'SUSPICIOUS',
      'recovered': true,
      'retryCount': 2,
    });
    final summary = ResultsSummary.fromResult(
      ApiResult(
        {
          'id': 'summary-1',
          'meetingId': 'meeting-1',
          'versionNumber': 2,
          'content': 'Summary',
          'sourceType': 'AI',
          'qualityStatus': 'READY_WITH_WARNINGS',
          'processingJobId': null,
          'transcriptId': 'transcript-1',
          'contentRevision': 3,
          'isStale': true,
          'createdAt': '2026-11-23T10:00:00Z',
          'createdByUserId': null,
          'aiWarnings': <String>['low coverage'],
          'aiProducer': {'provider': 'test', 'model': 'model-1'},
        },
        const {},
        '"summary-token"',
      ),
    );

    expect(coverage.status, 'SUSPICIOUS');
    expect(coverage.retryCount, 2);
    expect(summary.transcriptId, 'transcript-1');
    expect(summary.aiProducer?['model'], 'model-1');
  });

  test('rejects invalid transcript coverage status and timing', () {
    expect(
      () => TranscriptCoverageRegion.fromJson({
        'id': 'coverage-1',
        'startMs': 900,
        'endMs': 100,
        'coverageStatus': 'UNKNOWN',
        'recovered': false,
        'retryCount': 0,
      }),
      throwsA(isA<ApiFailure>()),
    );
  });
}
