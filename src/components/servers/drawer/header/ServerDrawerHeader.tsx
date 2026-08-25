import styles from "./styles.module.scss";

import { useNavigate, useParams } from "solid-navigator";
import { createSignal, Show } from "solid-js";
import useStore from "@/chat-api/store/useStore";
import ContextMenuServer from "@/components/servers/context-menu/ContextMenuServer";
import { ServerVerifiedIcon } from "../../ServerVerifiedIcon";
import Button from "@/components/ui/Button";
import { generateUrl } from "@/common/image";
import { ROLE_PERMISSIONS } from "@/chat-api/Bitwise";
import RouterEndpoints from "@/common/RouterEndpoints";

const ServerDrawerHeader = () => {
  const params = useParams();
  const navigate = useNavigate();
  const [contextPosition, setContextPosition] = createSignal<
    { x: number; y: number } | undefined
  >();
  const { servers, serverMembers, account } = useStore();
  const server = () => servers.get(params.serverId!);
  const bannerUrl = () => generateUrl(server(), "banner");
  const member = () =>
    serverMembers.get(params.serverId!, account.user()?.id!);
  const canManage = () =>
    serverMembers.hasPermission(member(), ROLE_PERMISSIONS.ADMIN);

  const onClick = (e: MouseEvent) => {
    setContextPosition({ x: e.clientX, y: e.clientY });
  };

  const openBannerSettings = (e: MouseEvent) => {
    e.stopPropagation();
    navigate(RouterEndpoints.SERVER_SETTINGS_GENERAL(params.serverId!));
  };

  return (
    <div
      class={styles.bannerHeader}
      style={{
        "background-color": server()?.hexColor || "var(--primary-color)"
      }}
      onClick={onClick}
    >
      <Show when={bannerUrl()}>
        <img class={styles.bannerImage} src={bannerUrl()!} alt="" />
      </Show>
      <div class={styles.bannerGradient} />
      <div class={styles.headerContainer}>
        <ContextMenuServer
          onClose={() => setContextPosition(undefined)}
          position={contextPosition()}
          serverId={params.serverId}
          triggerClassName={styles.showMoreIcon}
        />
        <div class={styles.serverName}>{server()?.name}</div>
        <Show when={server()?.verified}>
          <ServerVerifiedIcon />
        </Show>
        <Show when={canManage()}>
          <Button
            class={styles.bannerEditIcon}
            iconName="add_photo_alternate"
            iconSize={18}
            color="#fff"
            hoverText="Banner do servidor"
            onClick={openBannerSettings}
            padding={6}
          />
        </Show>
        <Button
          class={styles.showMoreIcon}
          iconName="expand_more"
          iconSize={20}
          color="#fff"
          onClick={onClick}
          padding={7}
        />
      </div>
      <Show when={canManage() && !bannerUrl()}>
        <div class={styles.addBannerHint}>Adicionar imagem</div>
      </Show>
    </div>
  );
};

export default ServerDrawerHeader;
