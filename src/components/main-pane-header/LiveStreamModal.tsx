import { Show } from "solid-js";
import { t } from "@nerimity/i18lite";
import { styled } from "solid-styled-components";
import useStore from "@/chat-api/store/useStore";
import { Modal } from "../ui/modal";
import Button from "../ui/Button";
import { useCustomPortal } from "../ui/custom-portal/CustomPortal";
import { useWindowProperties } from "@/common/useWindowProperties";
import {
  ScreenShareModal,
  LiveShareSettingsPicker
} from "./ScreenShareModal";
import { WebcamModal } from "./WebcamModal";

const Body = styled("div")`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 4px 4px;
`;

const Actions = styled("div")`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;

export function LiveStreamModal(props: { close: () => void }) {
  const { voiceUsers } = useStore();
  const { createPortal } = useCustomPortal();
  const { isMobileAgent } = useWindowProperties();

  const openScreenShare = () => {
    props.close();
    createPortal((close) => <ScreenShareModal close={close} />);
  };

  const openWebcam = () => {
    props.close();
    createPortal((close) => <WebcamModal close={close} />);
  };

  const stopLive = () => {
    voiceUsers.setVideoStream(null);
    props.close();
  };

  return (
    <Modal.Root close={props.close} desktopMaxWidth={560} desktopMinWidth={420}>
      <Modal.Header
        title={t("mainPaneHeader.voice.liveControls.title")}
        icon="monitor"
      />
      <Modal.Body>
        <Body>
          <Actions>
            <Show when={!isMobileAgent()}>
              <Button
                iconName="present_to_all"
                label={t("mainPaneHeader.voice.liveControls.changeScreen")}
                onClick={openScreenShare}
              />
            </Show>
            <Button
              iconName="videocam"
              label={t("mainPaneHeader.voice.liveControls.changeCamera")}
              onClick={openWebcam}
            />
          </Actions>
          <LiveShareSettingsPicker showAdvanced />
          <Button
            iconName="stop_screen_share"
            color="var(--alert-color)"
            label={t("mainPaneHeader.voice.liveControls.stopLive")}
            onClick={stopLive}
          />
        </Body>
      </Modal.Body>
    </Modal.Root>
  );
}
