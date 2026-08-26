import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { styled } from "solid-styled-components";
import useStore from "@/chat-api/store/useStore";
import {
  StorageKeys,
  useLocalStorage,
  useVoiceInputMode
} from "@/common/localStorage";
import Breadcrumb, { BreadcrumbItem } from "../ui/Breadcrumb";
import { t } from "@nerimity/i18lite";
import SettingsBlock, {
  SettingsGroup
} from "../ui/settings-block/SettingsBlock";
import DropDown, { DropDownItem } from "../ui/drop-down/DropDown";
import { Notice } from "../ui/Notice/Notice";
import { electronWindowAPI } from "@/common/Electron";
import { RadioBox } from "../ui/RadioBox";
import { FlexColumn } from "../ui/Flexbox";
import Input from "../ui/input/Input";
import Button from "../ui/Button";
import { downKeys, useGlobalKey } from "@/common/GlobalKey";
import { toast } from "../ui/custom-portal/CustomPortal";
import Checkbox from "../ui/Checkbox";
import Block from "../ui/settings-block/Block";
import { preloadNoiseSuppressor } from "@/common/noiseSuppressor";
import {
  NoiseSuppressionMode,
  VoiceMicConstraints,
  resolveNoiseSuppressionMode,
  getOutputGainPercent,
  setOutputGainPercent
} from "@/common/voiceAudioSettings";
import Slider from "../ui/Slider";
import Text from "../ui/Text";

const Container = styled("div")`
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
`;

const NoiseModeSettingsBlock = styled(SettingsBlock)`
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
`;

export default function CallSettings() {
  const { header } = useStore();

  createEffect(() => {
    header.updateHeader({
      title:
        t("settings.drawer.title") + " - " + t("settings.drawer.call-settings"),
      iconName: "settings"
    });
  });

  return (
    <Container>
      <Breadcrumb>
        <BreadcrumbItem href="/app" icon="home" title={t("dashboard.title")} />
        <BreadcrumbItem title={t("settings.drawer.call-settings")} />
      </Breadcrumb>
      <Notice type="info" description={t("settings.call.nextCallNotice")} />
      <InputDevices />
      <OutputDevices />
      <InputMode />
      <PushToTalk />
      <TurnServers />
    </Container>
  );
}

interface AvailableConstraint {
  label: string;
  description?: string;
  icon: string;
  key: "echo" | "gain";
  default: boolean;
}

function InputDevices() {
  const { voiceUsers } = useStore();
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [defaultDeviceId, setDefaultDeviceId] = createSignal<
    string | undefined
  >(undefined);
  const [inputDeviceId, setInputDeviceId] = useLocalStorage<string | undefined>(
    StorageKeys.inputDeviceId,
    undefined
  );

  const [supportedConstraints, setSupportedConstraints] = createSignal<
    AvailableConstraint[]
  >([]);

  const updateSupportedConstraints = () => {
    const supported = navigator.mediaDevices.getSupportedConstraints();
    const supportedList: AvailableConstraint[] = [];
    if (supported.echoCancellation)
      supportedList.push({
        label: t("settings.call.inputConstraints.echoCancelation"),
        description: t(
          "settings.call.inputConstraints.echoCancelationDescription"
        ),
        icon: "record_voice_over",
        key: "echo",
        default: true
      });
    if (supported.autoGainControl)
      supportedList.push({
        label: t("settings.call.inputConstraints.autoGainControl"),
        description: t(
          "settings.call.inputConstraints.autoGainControlDescription"
        ),
        icon: "settings_voice",
        key: "gain",
        default: true
      });
    setSupportedConstraints(supportedList);
  };

  const dropDownItem = () => {
    return devices().map((d) => ({
      id: d.deviceId,
      label: d.label
    })) satisfies DropDownItem[];
  };

  onMount(async () => {
    void preloadNoiseSuppressor();
    updateSupportedConstraints();
    const defaultStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    setDefaultDeviceId(
      defaultStream.getAudioTracks()[0]?.getSettings().deviceId
    );
    defaultStream.getTracks().forEach((track) => track.stop());

    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setDevices(devices.filter((device) => device.kind === "audioinput"));
    });
  });

  const [constraints, setConstraints] = useLocalStorage(
    StorageKeys.voiceMicConstraints,
    { echo: true, gain: true, noiseMode: "enhanced" } as VoiceMicConstraints
  );

  const noiseMode = () => resolveNoiseSuppressionMode(constraints());

  const setNoiseMode = (mode: NoiseSuppressionMode) => {
    setConstraints({
      ...constraints(),
      noiseMode: mode
    });
    void voiceUsers.restartMic?.();
  };

  return (
    <SettingsGroup>
      <SettingsBlock icon="mic" label={t("settings.call.inputDevices")}>
        <DropDown
          items={dropDownItem()}
          selectedId={
            inputDeviceId() || defaultDeviceId() || t("settings.call.default")
          }
          onChange={(e) => {
            setInputDeviceId(e.id);
            void voiceUsers.restartMic?.();
          }}
        />
      </SettingsBlock>
      <NoiseModeSettingsBlock
        icon="noise_aware"
        label={t("settings.call.inputConstraints.noiseSuppression")}
        description={t(
          "settings.call.inputConstraints.noiseSuppressionDescription"
        )}
      >
        <RadioBox
          items={[
            {
              id: "disabled",
              label: t("settings.call.noiseModes.disabled")
            },
            {
              id: "browser",
              label: t("settings.call.noiseModes.browser")
            },
            {
              id: "enhanced",
              label: t("settings.call.noiseModes.enhanced")
            }
          ]}
          initialId={noiseMode()}
          onChange={(item) => setNoiseMode(item.id as NoiseSuppressionMode)}
        />
      </NoiseModeSettingsBlock>
      <For each={supportedConstraints()}>
        {(constraint) => (
          <CheckboxOption
            constraint={constraint}
            checked={!!constraints()[constraint.key]}
            onChange={(val) => {
              setConstraints({
                ...constraints(),
                [constraint.key]: val
              });
              void voiceUsers.restartMic?.();
            }}
          />
        )}
      </For>
    </SettingsGroup>
  );
}

function OutputDevices() {
  const { voiceUsers } = useStore();
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useLocalStorage<
    string | undefined
  >(StorageKeys.outputDeviceId, undefined);
  const [outputGain, setOutputGain] = createSignal(getOutputGainPercent());

  const dropDownItem = () => {
    return devices().map((d) => ({
      id: d.deviceId,
      label: d.label
    })) satisfies DropDownItem[];
  };

  const defaultDeviceId = () => {
    const defaultDevice = devices().find((d) => d.deviceId === "default");
    if (defaultDevice) {
      return defaultDevice.deviceId;
    }
    return devices()[0]?.deviceId;
  };

  onMount(async () => {
    await navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((s) => s.getAudioTracks()[0]?.stop());
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setDevices(devices.filter((device) => device.kind === "audiooutput"));
    });
  });

  const onOutputGainChange = (value: number) => {
    setOutputGain(value);
  };

  const onOutputGainEnd = () => {
    setOutputGainPercent(outputGain());
    voiceUsers.reapplyAllRemoteVolumes();
  };

  return (
    <SettingsGroup>
      <SettingsBlock icon="speaker" label={t("settings.call.outputDevices")}>
        <DropDown
          items={dropDownItem()}
          selectedId={
            outputDeviceId() || defaultDeviceId() || t("settings.call.default")
          }
          onChange={(e) => setOutputDeviceId(e.id)}
        />
      </SettingsBlock>
      <SettingsBlock
        icon="volume_up"
        label={t("settings.call.outputVolume")}
        description={t("settings.call.outputVolumeDescription")}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <Slider
            min={0}
            max={200}
            value={outputGain()}
            onChange={(v) => onOutputGainChange(Number(v))}
            onEnd={onOutputGainEnd}
          />
          <Text style={{ width: "48px", "text-align": "center" }}>
            {outputGain()}%
          </Text>
        </div>
      </SettingsBlock>
    </SettingsGroup>
  );
}

function InputMode() {
  const [inputMode, setInputMode] = useVoiceInputMode();
  const store = useStore();

  const isInCall = () => store.voiceUsers.currentUser()?.channelId;

  return (
    <SettingsGroup>
      <SettingsBlock icon="steppers" label={t("settings.call.inputMode")} />
      <Block
        onClick={() => {
          if (isInCall()) {
            toast(t("settings.call.leaveCall"));
          }
        }}
        style={{ "padding-left": "50px" }}
      >
        <RadioBox
          style={isInCall() ? { "pointer-events": "none" } : {}}
          initialId={inputMode()}
          onChange={(e) => setInputMode(e.id)}
          items={[
            { id: "OPEN", label: t("settings.call.openMic") },
            { id: "VOICE_ACTIVITY", label: t("settings.call.voiceActivity") },
            { id: "PTT", label: t("settings.call.pushToTalk") }
          ]}
        />
      </Block>
    </SettingsGroup>
  );
}

function PushToTalk() {
  const [inputMode] = useVoiceInputMode();
  const [bindMode, setBindMode] = createSignal(false);
  const [PTTBoundKeys, setPTTBoundKeys] = useLocalStorage(
    StorageKeys.PTTBoundKeys,
    [] as (string | number)[]
  );
  const store = useStore();

  const isInCall = () => store.voiceUsers.currentUser()?.channelId;

  const toggleBindMode = () => setBindMode(!bindMode());

  const { start, stop } = useGlobalKey();

  createEffect(() => {
    if (inputMode() !== "PTT") {
      setBindMode(false);
    }
  });

  createEffect(
    on(bindMode, (bindMode) => {
      if (bindMode) {
        if (isInCall()) {
          toast(t("settings.call.leaveCall"));
          setBindMode(false);
          return;
        }
        start();
      } else {
        stop();
      }
    })
  );

  createEffect(
    on([() => downKeys.length, () => [...downKeys]], (input, prevInput) => {
      if (!bindMode()) return;

      if (prevInput && input < prevInput) {
        setPTTBoundKeys(prevInput[1]!);
        setBindMode(false);
      }
    })
  );

  const value = () => {
    if (bindMode()) {
      return downKeys.map((k) => k).join(" + ");
    }
    return PTTBoundKeys()
      .map((k) => k)
      .join(" + ");
  };
  return (
    <Show when={inputMode() === "PTT"}>
      <FlexColumn gap={4} style={{ "margin-top": "10px" }}>
        <Show when={!electronWindowAPI()?.isElectron}>
          <Notice
            type="info"
            description={t("settings.call.downloadAppNotice")}
          />
        </Show>
        <SettingsBlock icon="keyboard" label={t("settings.call.pushToTalk")}>
          <Input
            disabled
            value={value()}
            suffix={
              <Button
                onkeydown={(e) => e.preventDefault()}
                color={bindMode() ? "var(--alert-color)" : undefined}
                label={
                  bindMode()
                    ? t("settings.call.stopButton")
                    : t("settings.call.bindButton")
                }
                onClick={toggleBindMode}
              />
            }
          />
        </SettingsBlock>
      </FlexColumn>
    </Show>
  );
}

function CheckboxOption(props: {
  constraint: AvailableConstraint;
  onChange: (checked: boolean) => void;
  checked: boolean;
}) {
  return (
    <SettingsBlock
      icon={props.constraint.icon}
      label={props.constraint.label}
      description={props.constraint.description}
      onClick={() => props.onChange?.(!props.checked)}
    >
      <Checkbox checked={props.checked} />
    </SettingsBlock>
  );
}

function TurnServers() {
  const [enabled, setEnabled] = useLocalStorage(
    StorageKeys.voiceUseTurnServers,
    true
  );
  return (
    <SettingsBlock
      label={t("settings.call.useTurn")}
      description={t("settings.call.useTurnDescription")}
      icon="cloud"
      onClick={() => setEnabled(!enabled())}
    >
      <Checkbox checked={enabled()} />
    </SettingsBlock>
  );
}
