import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:openapi/api.dart';

void main() {
  test('generated admin DTOs retain native enum defaults', () {
    expect(
      AdminConfigAdvancedPromptDto().placeholderValidation.value,
      AdminConfigAdvancedPromptDtoPlaceholderValidationEnum.strict,
    );
    expect(AdminConfigImageDescriptionPromptDto().style.value, AdminConfigImageDescriptionPromptDtoStyleEnum.balanced);

    final runPod = AdminConfigRunPodDto(
      apiKey: '',
      autoBackfillOnLaunch: false,
      autoStopEnabled: false,
      autoStopGraceMinutes: 0,
      containerDiskGb: 0,
      dataPrivacyAcknowledged: false,
      defaultGpuTypeId: '',
      enabled: false,
      imageName: '',
      maxRuntimeHours: 0,
      volumeGb: 0,
    );
    expect(runPod.mode.value, AdminConfigRunPodDtoModeEnum.disabled);
    expect(jsonDecode(jsonEncode(runPod))['mode'], 'disabled');
  });
}
