import '../../core/api_client.dart';
import '../../core/api_model_validation.dart';

class UserProfile {
  const UserProfile._({
    required this.id,
    required this.email,
    required this.displayName,
    required this.globalRole,
    required this.accountStatus,
    required this.primaryOrgUnitId,
  });

  final AuthUuid id;
  final String email;
  final String displayName;
  final AuthGlobalRole globalRole;
  final AuthAccountStatus accountStatus;
  final AuthUuid? primaryOrgUnitId;

  factory UserProfile.fromResult(ApiResult response) {
    final raw = response.objectData();
    final org = _nullableIdentifier(raw, 'primaryOrgUnitId', response);
    return UserProfile._(
      id: AuthUuid.parse(
        requiredIdentifier(raw, 'id', response: response),
        response: response,
      ),
      email: requiredString(raw, 'email', response: response, nonEmpty: true),
      displayName: requiredString(
        raw,
        'displayName',
        response: response,
        nonEmpty: true,
      ),
      globalRole: switch (raw['globalRole']) {
        'EMPLOYEE' => AuthGlobalRole.employee,
        'DEPARTMENT_MANAGER' => AuthGlobalRole.departmentManager,
        'ADMINISTRATOR' => AuthGlobalRole.administrator,
        _ => invalidApiData(response: response),
      },
      accountStatus: switch (raw['accountStatus']) {
        'PENDING_SETUP' => AuthAccountStatus.pendingSetup,
        'ACTIVE' => AuthAccountStatus.active,
        'INACTIVE' => AuthAccountStatus.inactive,
        _ => invalidApiData(response: response),
      },
      primaryOrgUnitId: org == null
          ? null
          : AuthUuid.parse(org, response: response),
    );
  }
}

class ProfileSnapshot {
  const ProfileSnapshot._(this.profile, this.etag, this.sessionScope);

  final UserProfile profile;
  final String etag;
  final AuthenticatedSessionScope sessionScope;

  factory ProfileSnapshot.fromResult(
    ApiResult response,
    AuthenticatedSessionScope scope,
  ) {
    final profile = UserProfile.fromResult(response);
    final etag = response.etag;
    if (profile.id.value != scope.userId.toLowerCase() ||
        profile.accountStatus != AuthAccountStatus.active ||
        etag == null ||
        !RegExp(r'^"[^"\x00-\x20\x7f]*"$').hasMatch(etag)) {
      throw response.invalidDataFailure();
    }
    return ProfileSnapshot._(profile, etag, scope);
  }
}

class UserPreferences {
  const UserPreferences._({
    required this.timezone,
    required this.locale,
    required this.meetingEmailEnabled,
    required this.actionItemEmailEnabled,
  });

  final String? timezone;
  final String? locale;
  final bool meetingEmailEnabled;
  final bool actionItemEmailEnabled;

  factory UserPreferences.fromResult(ApiResult response) {
    final raw = response.objectData();
    return UserPreferences._(
      timezone: _nullableIdentifier(raw, 'timezone', response),
      locale: _nullableIdentifier(raw, 'locale', response),
      meetingEmailEnabled: requiredBool(
        raw,
        'meetingEmailEnabled',
        response: response,
      ),
      actionItemEmailEnabled: requiredBool(
        raw,
        'actionItemEmailEnabled',
        response: response,
      ),
    );
  }
}

class PreferencesSnapshot {
  const PreferencesSnapshot(this.preferences, this.sessionScope);

  final UserPreferences preferences;
  final AuthenticatedSessionScope sessionScope;
}

String? _nullableIdentifier(
  Map<String, dynamic> raw,
  String field,
  ApiResult response,
) {
  if (!raw.containsKey(field)) invalidApiData(response: response);
  return optionalIdentifier(raw, field, response: response);
}
