import '../../core/api_client.dart';
import '../../core/api_model_validation.dart';
import '../../core/meeting_models.dart';
import '../../core/paged_collection.dart';
import '../meetings/meeting_membership.dart';
import '../meetings/meeting_repository.dart';
import '../meetings/meeting_foundation.dart';
import 'results_models.dart';

class ResultsAccessVerification {
  const ResultsAccessVerification({
    required this.canRead,
    this.canMutate,
    this.meetingTitle,
  });

  final bool canRead;
  final bool? canMutate;
  final String? meetingTitle;
}

/// Typed transport boundary for all existing Meeting Results operations.
class ResultsRepository {
  ResultsRepository(this.api, {this.meetings, this.membership});

  final ApiClient api;
  final MeetingRepository? meetings;
  final MeetingMembershipRepository? membership;
  bool _accessVerificationInProgress = false;

  /// A concealed 404 is not evidence that a result is merely absent.
  /// Re-check canonical meeting membership, not cached presentation state.
  Future<bool> verifyReadAccess({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    return (await verifyAccess(
      sessionScope: sessionScope,
      meetingId: meetingId,
    )).canRead;
  }

  Future<ResultsAccessVerification> verifyAccess({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final meetingRepository = meetings;
    final membershipRepository = membership;
    if (meetingRepository == null || membershipRepository == null) {
      // Test doubles and lightweight compositions may only implement the
      // existing boolean boundary. They cannot establish a fresh mutation
      // capability, so the caller must retain the previous mutation decision
      // only if read access itself is verified.
      if (_accessVerificationInProgress) {
        return const ResultsAccessVerification(canRead: false);
      }
      _accessVerificationInProgress = true;
      try {
        return ResultsAccessVerification(
          canRead: await verifyReadAccess(
            sessionScope: sessionScope,
            meetingId: meetingId,
          ),
        );
      } finally {
        _accessVerificationInProgress = false;
      }
    }
    final snapshot = await meetingRepository.detail(meetingId);
    api.requireCurrentAuthenticatedSession(sessionScope);
    final meeting = snapshot.meeting;
    if (meeting.organizerId.toLowerCase() ==
        sessionScope.userId.toLowerCase()) {
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: sessionScope.userId,
        meeting: meeting,
      );
      return ResultsAccessVerification(
        canRead: capabilities.canReadMedia,
        canMutate: capabilities.canReadMedia,
        meetingTitle: capabilities.canReadMedia ? meeting.title : null,
      );
    }
    final records = await membershipRepository.listParticipants(
      meetingId,
      sessionScope: sessionScope,
    );
    api.requireCurrentAuthenticatedSession(sessionScope);
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: sessionScope.userId,
      meeting: meeting,
      callerIsActiveParticipant: records.any(
        (record) =>
            record.isActive &&
            record.userId.toLowerCase() == sessionScope.userId.toLowerCase(),
      ),
    );
    return ResultsAccessVerification(
      canRead: capabilities.canReadMedia,
      canMutate: false,
      meetingTitle: capabilities.canReadMedia ? meeting.title : null,
    );
  }

  Future<Transcript> currentTranscript({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/transcript',
    );
    final value = Transcript.fromResult(response);
    _requireOwnership(sessionScope, meetingId, value.meetingId);
    return value;
  }

  Future<List<SpeakerCluster>> speakerClusters({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/speaker-clusters',
    );
    _requireOwnership(sessionScope, meetingId, meetingId);
    return response
        .objectArrayData()
        .map((raw) => SpeakerCluster.fromJson(raw, response: response))
        .toList(growable: false);
  }

  Future<List<TranscriptCoverageRegion>> coverage({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/transcript/coverage',
    );
    return response
        .objectArrayData()
        .map(
          (raw) => TranscriptCoverageRegion.fromJson(raw, response: response),
        )
        .toList(growable: false);
  }

  Future<TranscriptCoverage> currentTranscriptCoverage({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    bool Function()? stillAuthorized,
  }) async {
    final authorized = stillAuthorized ?? () => true;
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!authorized()) throw _accessChanged();
      final before = await currentTranscript(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!authorized()) throw _accessChanged();
      final regions = await coverage(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!authorized()) throw _accessChanged();
      final after = await currentTranscript(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!authorized()) throw _accessChanged();
      if (before.id == after.id &&
          before.etag != null &&
          before.etag == after.etag) {
        return TranscriptCoverage(
          transcriptId: before.id,
          transcriptEtag: before.etag!,
          regions: List.unmodifiable(regions),
        );
      }
    }
    throw const ApiFailure(
      412,
      'RESULTS_REVIEW_CHANGED',
      'Transcript đã thay đổi. Vui lòng tải lại và xem xét lại.',
    );
  }

  Future<SpeakerReviewSnapshot> speakerReview({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required bool Function() stillAuthorized,
  }) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!stillAuthorized()) throw _accessChanged();
      final before = await currentTranscript(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!stillAuthorized()) throw _accessChanged();
      final clusters = await speakerClusters(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!stillAuthorized()) throw _accessChanged();
      final after = await currentTranscript(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!stillAuthorized()) throw _accessChanged();
      final etag = before.etag;
      if (etag != null &&
          etag.isNotEmpty &&
          before.id == after.id &&
          etag == after.etag) {
        return SpeakerReviewSnapshot(
          transcriptId: before.id,
          etag: etag,
          clusters: List.unmodifiable(clusters),
        );
      }
    }
    throw const ApiFailure(
      412,
      'RESULTS_REVIEW_CHANGED',
      'Transcript đã thay đổi. Vui lòng tải lại và xem xét lại.',
    );
  }

  ApiFailure _accessChanged() => const ApiFailure(
    403,
    'RESULTS_ACCESS_CHANGED',
    'Quyền truy cập đã thay đổi.',
  );

  Future<ResultsSummary> currentSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(sessionScope, '/meetings/$meetingId/summary');
    final value = ResultsSummary.fromResult(response);
    _requireOwnership(sessionScope, meetingId, value.meetingId);
    return value;
  }

  Future<PagedCollection<SummaryVersion>> summaryVersions({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    int page = 0,
    int size = 20,
  }) async {
    if (size < 1 || size > 20) throw ArgumentError.value(size, 'size');
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/summary/versions',
      query: {'page': '$page', 'size': '$size'},
    );
    return PagedCollection<SummaryVersion>.fromResult(
      response,
      (raw) => SummaryVersion.fromJson(raw, response: response),
      requestedPage: page,
      requestedSize: size,
    );
  }

  Future<PagedCollection<MeetingDecision>> decisions({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    int page = 0,
    int size = 20,
    String? status,
  }) async {
    if (size < 1 || size > 100) throw ArgumentError.value(size, 'size');
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/decisions',
      query: {
        'page': '$page',
        'size': '$size',
        if (status != null) 'status': status,
      },
    );
    return PagedCollection<MeetingDecision>.fromResult(
      response,
      (raw) {
        final decision = MeetingDecision.fromJson(raw, response: response);
        _requireOwnership(sessionScope, meetingId, decision.meetingId);
        if (!const {
              'PROPOSED',
              'CONFIRMED',
              'REJECTED',
            }.contains(decision.status) ||
            (status != null && decision.status != status)) {
          throw response.invalidDataFailure();
        }
        return decision;
      },
      requestedPage: page,
      requestedSize: size,
    );
  }

  Future<MeetingMinutes> minutes({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(sessionScope, '/meetings/$meetingId/minutes');
    final value = MeetingMinutes.fromResult(response);
    _requireOwnership(sessionScope, meetingId, value.meetingId);
    return value;
  }

  Future<ApiResult> correctSegment({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required SpeechSegment snapshot,
    required String text,
    String? reason,
  }) async {
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/transcript/segments/${snapshot.id}',
      {
        'text': text,
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason,
      },
      etag: snapshot.etag,
    );
    return _validatedMutationResponse(response, requireBodyEtag: true);
  }

  Future<ApiResult> mapSpeaker({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String clusterId,
    required String transcriptEtag,
    required String? userId,
  }) async {
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/speaker-clusters/$clusterId',
      {'userId': userId},
      etag: transcriptEtag,
    );
    return _validatedMutationResponse(response);
  }

  Future<ResultsSummary> editSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required ResultsSummary snapshot,
    required String content,
  }) async {
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/summary',
      {'content': content},
      etag: snapshot.etag,
    );
    return ResultsSummary.fromResult(_validatedMutationResponse(response));
  }

  Future<ResultsSummary> activateSummaryVersion({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required ResultsSummary snapshot,
    required String versionId,
  }) async {
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/summary/versions/$versionId/activate',
      const <String, dynamic>{},
      etag: snapshot.etag,
    );
    return ResultsSummary.fromResult(_validatedMutationResponse(response));
  }

  Future<MeetingDecision> createDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String content,
    List<String> evidenceSegmentIds = const [],
    Transcript? reviewedTranscript,
  }) async {
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/decisions',
      {
        'content': content,
        'evidenceSegmentIds': evidenceSegmentIds,
        if (reviewedTranscript != null && evidenceSegmentIds.isNotEmpty) ...{
          'reviewedTranscriptId': reviewedTranscript.id,
          'reviewedContentRevision': reviewedTranscript.contentRevision,
        },
      },
    );
    final decision = MeetingDecision.fromJson(
      _validatedMutationResponse(response, requireBodyEtag: true).objectData(),
      response: response,
    );
    _requireOwnership(sessionScope, meetingId, decision.meetingId);
    if (decision.status != 'CONFIRMED' ||
        decision.content != content ||
        decision.evidenceSegmentIds.length != evidenceSegmentIds.length ||
        !decision.evidenceSegmentIds.toSet().containsAll(evidenceSegmentIds) ||
        (evidenceSegmentIds.isNotEmpty &&
            reviewedTranscript != null &&
            (decision.transcriptId != reviewedTranscript.id ||
                decision.contentRevision !=
                    reviewedTranscript.contentRevision))) {
      throw response.invalidDataFailure();
    }
    return decision;
  }

  Future<ApiResult> editDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required String content,
  }) async {
    _requireOwnership(sessionScope, meetingId, snapshot.meetingId);
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/decisions/${snapshot.id}',
      {'content': content},
      etag: snapshot.etag,
    );
    return _validateDecisionMutation(
      response,
      sessionScope: sessionScope,
      meetingId: meetingId,
      snapshot: snapshot,
      expectedStatus: 'CONFIRMED',
      expectedContent: content,
    );
  }

  Future<ApiResult> reviewDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required bool confirm,
  }) async {
    _requireOwnership(sessionScope, meetingId, snapshot.meetingId);
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/decisions/${snapshot.id}/${confirm ? 'confirm' : 'reject'}',
      const <String, dynamic>{},
      etag: _requireEtag(snapshot.etag),
    );
    return _validateDecisionMutation(
      response,
      sessionScope: sessionScope,
      meetingId: meetingId,
      snapshot: snapshot,
      expectedStatus: confirm ? 'CONFIRMED' : 'REJECTED',
      expectedContent: snapshot.content,
    );
  }

  ApiResult _validateDecisionMutation(
    ApiResult response, {
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required String expectedStatus,
    required String expectedContent,
  }) {
    final validated = _validatedMutationResponse(
      response,
      requireBodyEtag: true,
    );
    final decision = MeetingDecision.fromJson(
      validated.objectData(),
      response: response,
    );
    _requireOwnership(sessionScope, meetingId, decision.meetingId);
    if (decision.id != snapshot.id ||
        decision.status != expectedStatus ||
        decision.content != expectedContent) {
      throw response.invalidDataFailure();
    }
    return validated;
  }

  Future<String> regenerateSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String idempotencyKey,
  }) async {
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/summary/regenerate',
      const <String, dynamic>{},
      headers: {'Idempotency-Key': idempotencyKey},
    );
    final raw = response.objectData();
    _requireOwnership(
      sessionScope,
      meetingId,
      requiredIdentifier(raw, 'meetingId', response: response),
    );
    return requiredIdentifier(raw, 'processingJobId', response: response);
  }

  Future<List<SpeakerCandidate>> meetingCandidates({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String query,
    required bool Function() stillAuthorized,
  }) async {
    final meetingRepository = meetings;
    final membershipRepository = membership;
    if (meetingRepository == null ||
        membershipRepository == null ||
        !stillAuthorized())
      throw _accessChanged();
    final snapshot = await meetingRepository.detail(meetingId);
    if (!stillAuthorized()) throw _accessChanged();
    final organizer = snapshot.meeting.organizerId;
    final records = await membershipRepository.listParticipants(
      meetingId,
      sessionScope: sessionScope,
    );
    if (!stillAuthorized()) throw _accessChanged();
    final organizerLabel = await meetingRepository.organizer(
      organizer,
      sessionScope: sessionScope,
    );
    if (!stillAuthorized()) throw _accessChanged();
    final candidates = <SpeakerCandidate>[
      SpeakerCandidate(organizer, organizerLabel.name),
      for (final record in records)
        if (record.isActive &&
            record.userId.toLowerCase() != organizer.toLowerCase())
          SpeakerCandidate(record.userId, record.displayName ?? record.userId),
    ];
    final needle = query.trim().toLowerCase();
    return List.unmodifiable(
      candidates.where(
        (candidate) => candidate.displayName.toLowerCase().contains(needle),
      ),
    );
  }

  Future<ApiResult> _get(
    AuthenticatedSessionScope scope,
    String path, {
    Map<String, String>? query,
  }) => api.get(path, query: query, sessionScope: scope);

  Future<ApiResult> _patch(
    AuthenticatedSessionScope scope,
    String path,
    Map<String, dynamic> body, {
    required String? etag,
  }) {
    final token = _requireEtag(etag);
    return api.patch(
      path,
      body,
      headers: {'If-Match': token},
      sessionScope: scope,
    );
  }

  Future<ApiResult> _post(
    AuthenticatedSessionScope scope,
    String path,
    Map<String, dynamic> body, {
    String? etag,
    Map<String, String>? headers,
  }) {
    final requestHeaders = <String, String>{...?headers};
    if (etag != null) {
      _requireEtag(etag);
      requestHeaders['If-Match'] = etag;
    }
    return api.post(
      path,
      body,
      headers: requestHeaders.isEmpty ? null : requestHeaders,
      sessionScope: scope,
    );
  }

  ApiResult _validatedMutationResponse(
    ApiResult response, {
    bool requireBodyEtag = false,
  }) {
    final header = response.etag;
    if (header == null || header.trim().isEmpty) {
      throw response.invalidDataFailure();
    }
    if (!requireBodyEtag) return response;
    final bodyTag = response.objectData()['etag'];
    if (bodyTag is! String || bodyTag.trim().isEmpty || bodyTag != header) {
      throw response.invalidDataFailure();
    }
    return response;
  }

  void _requireOwnership(
    AuthenticatedSessionScope scope,
    String expectedMeetingId,
    String actualMeetingId,
  ) {
    api.requireCurrentAuthenticatedSession(scope);
    if (expectedMeetingId.toLowerCase() != actualMeetingId.toLowerCase()) {
      throw const ApiFailure(
        0,
        ApiFailure.invalidResponseCode,
        'The server returned data for a different meeting.',
      );
    }
  }

  String _requireEtag(String? value) {
    if (value == null ||
        value.trim().isEmpty ||
        value.contains('\r') ||
        value.contains('\n')) {
      throw const ApiFailure(
        0,
        'VERSION_MISSING',
        'Không nhận được phiên bản dữ liệu. Vui lòng tải lại.',
      );
    }
    return value;
  }
}
