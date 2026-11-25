import '../../core/api_client.dart';
import '../../core/meeting_models.dart';
import '../../core/paged_collection.dart';
import '../meetings/meeting_membership.dart';
import '../meetings/meeting_repository.dart';
import '../meetings/meeting_foundation.dart';
import 'results_models.dart';

/// Typed transport boundary for all existing Meeting Results operations.
class ResultsRepository {
  ResultsRepository(this.api, {this.meetings, this.membership});

  final ApiClient api;
  final MeetingRepository? meetings;
  final MeetingMembershipRepository? membership;

  /// A concealed 404 is not evidence that a result is merely absent.
  /// Re-check canonical meeting membership, not cached presentation state.
  Future<bool> verifyReadAccess({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final meetingRepository = meetings;
    final membershipRepository = membership;
    if (meetingRepository == null || membershipRepository == null) return false;
    final snapshot = await meetingRepository.detail(meetingId);
    api.requireCurrentAuthenticatedSession(sessionScope);
    final meeting = snapshot.meeting;
    if (meeting.organizerId.toLowerCase() ==
        sessionScope.userId.toLowerCase()) {
      return MeetingCapabilityPolicy.evaluate(
        callerId: sessionScope.userId, meeting: meeting,
      ).canReadMedia;
    }
    final records = await membershipRepository.listParticipants(
      meetingId, sessionScope: sessionScope,
    );
    api.requireCurrentAuthenticatedSession(sessionScope);
    return MeetingCapabilityPolicy.evaluate(
      callerId: sessionScope.userId,
      meeting: meeting,
      callerIsActiveParticipant: records.any((record) =>
        record.isActive &&
        record.userId.toLowerCase() == sessionScope.userId.toLowerCase()),
    ).canReadMedia;
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
  }) async {
    if (size < 1 || size > 100) throw ArgumentError.value(size, 'size');
    final response = await _get(
      sessionScope,
      '/meetings/$meetingId/decisions',
      query: {'page': '$page', 'size': '$size'},
    );
    return PagedCollection<MeetingDecision>.fromResult(
      response,
      (raw) => MeetingDecision.fromJson(raw, response: response),
      requestedPage: page,
      requestedSize: size,
    );
  }

  Future<MeetingMinutes> minutes({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final response = await _get(sessionScope, '/meetings/$meetingId/minutes');
    return MeetingMinutes.fromResult(response);
  }

  Future<ApiResult> correctSegment({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required SpeechSegment snapshot,
    required String text,
  }) async {
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/transcript/segments/${snapshot.id}',
      {'text': text},
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
  }) async {
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/decisions',
      {'content': content, 'evidenceSegmentIds': <String>[]},
    );
    return MeetingDecision.fromJson(
      _validatedMutationResponse(response, requireBodyEtag: true).objectData(),
      response: response,
    );
  }

  Future<ApiResult> editDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required String content,
  }) async {
    final response = await _patch(
      sessionScope,
      '/meetings/$meetingId/decisions/${snapshot.id}',
      {'content': content},
      etag: snapshot.etag,
    );
    return _validatedMutationResponse(response, requireBodyEtag: true);
  }

  Future<ApiResult> reviewDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required bool confirm,
  }) async {
    final response = await _post(
      sessionScope,
      '/meetings/$meetingId/decisions/${snapshot.id}/${confirm ? 'confirm' : 'reject'}',
      const <String, dynamic>{},
      etag: snapshot.etag,
    );
    return _validatedMutationResponse(response, requireBodyEtag: true);
  }

  Future<ApiResult> regenerateSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String idempotencyKey,
  }) => _post(
    sessionScope,
    '/meetings/$meetingId/summary/regenerate',
    const <String, dynamic>{},
    headers: {'Idempotency-Key': idempotencyKey},
  );

  Future<List<Map<String, dynamic>>> meetingCandidates({
    required AuthenticatedSessionScope sessionScope,
    required String query,
  }) async => (await _get(
    sessionScope,
    '/users/meeting-candidates',
    query: {'q': query, 'size': '20'},
  )).objectArrayData();

  Future<ApiResult> _get(
    AuthenticatedSessionScope scope,
    String path, {
    Map<String, String>? query,
  }) => api.get(path, query: query, sessionScope: scope);

  Future<ApiResult> _patch(
    AuthenticatedSessionScope scope,
    String path,
    Map<String, dynamic> body, {
    required String etag,
  }) {
    _requireEtag(etag);
    return api.patch(
      path,
      body,
      headers: {'If-Match': etag},
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

  void _requireEtag(String value) {
    if (value.trim().isEmpty || value.contains('\r') || value.contains('\n')) {
      throw const ApiFailure(
        0,
        'VERSION_MISSING',
        'Không nhận được phiên bản dữ liệu. Vui lòng tải lại.',
      );
    }
  }
}
