import {
  Show,
  For,
  Switch,
  Match,
  createSignal,
  createMemo
} from "solid-js";
import style from "./style.module.scss";
import ServerDrawerHeader from "./header/ServerDrawerHeader";
import {
  CategoryControllerProvider,
  ServerDrawerControllerProvider,
  useCategoryController,
  useServerDrawerController
} from "./ServerDrawerController";
import { Skeleton } from "@/components/ui/skeleton/Skeleton";
import useStore from "@/chat-api/store/useStore";
import { ChannelType, ServerNotificationPingMode } from "@/chat-api/RawData";
import { Channel } from "@/chat-api/store/useChannels";
import { cn } from "@/common/classNames";
import { Tooltip } from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import Icon from "@/components/ui/icon/Icon";
import { ChannelIcon } from "@/components/ChannelIcon";
import { t } from "@nerimity/i18lite";
import { messagesPreloader } from "@/common/createPreloader";
import RouterEndpoints from "@/common/RouterEndpoints";
import { Item } from "@/components/ui/Item";
import { emitDrawerGoToMain } from "@/common/GlobalEvents";
import { styled } from "solid-styled-components";
import { FlexColumn } from "@/components/ui/Flexbox";
import Avatar from "@/components/ui/Avatar";
import InVoiceActions from "@/components/InVoiceActions";
import { useWindowProperties } from "@/common/useWindowProperties";
import { useMatch, useParams } from "solid-navigator";
import ContextMenuServerChannel from "../context-menu/ContextMenuServerChannel";
import MemberContextMenu from "@/components/member-context-menu/MemberContextMenu";
import { VoiceUser } from "@/chat-api/store/useVoiceUsers";

const ServerDrawer = () => {
  return (
    <ServerDrawerControllerProvider>
      <ServerDrawerContent />
    </ServerDrawerControllerProvider>
  );
};

const ServerDrawerContent = () => {
  const params = useParams<{ serverId: string }>();
  const store = useStore();
  const { isMobileWidth } = useWindowProperties();
  const controller = useServerDrawerController();

  const server = () => store.servers.get(params.serverId);
  return (
    <>
      <Show when={controller?.contextMenuDetails()}>
        <ContextMenuServerChannel
          {...controller?.contextMenuDetails()}
          onClose={() => controller?.setContextMenuDetails(undefined)}
        />
      </Show>
      <ServerDrawerHeader />
      <div class={style.serverDrawer}>
        <div class={style.serverDrawerInner}>
          <Show when={server()?.joinedThisSession}>
            <JoinedThisSessionNotificationNotice />
          </Show>
          <MembersItem />
          <Show when={server()?._count?.welcomeQuestions}>
            <CustomizeItem />
          </Show>
          <ChannelList />
          <InVoiceActions
            style={
              isMobileWidth()
                ? { bottom: "calc(var(--bottom-pane-gap) + 6px)" }
                : {}
            }
          />
        </div>
      </div>
    </>
  );
};

const CustomizeItem = () => {
  const params = useParams<{ serverId: string }>();
  const match = useMatch(() =>
    RouterEndpoints.SERVER_MESSAGES(params.serverId!, "welcome")
  );
  return (
    <div class={style.welcomeItemContainer}>
      <Item.Root
        href={RouterEndpoints.SERVER_MESSAGES(params.serverId!, "welcome")}
        onClick={() => emitDrawerGoToMain()}
        selected={!!match()}
      >
        <Item.Icon>tune</Item.Icon>
        <Item.Label>{t("channelDrawer.customize.title")}</Item.Label>
      </Item.Root>
    </div>
  );
};
const MembersItem = () => {
  const params = useParams<{ serverId: string }>();
  const match = useMatch(() =>
    RouterEndpoints.SERVER_MESSAGES(params.serverId!, "members")
  );
  return (
    <div class={style.membersItemContainer}>
      <Item.Root
        href={RouterEndpoints.SERVER_MESSAGES(params.serverId!, "members")}
        onClick={() => emitDrawerGoToMain()}
        selected={!!match()}
      >
        <Item.Icon>group</Item.Icon>
        <Item.Label>{t("informationDrawer.members")}</Item.Label>
      </Item.Root>
    </div>
  );
};

const ChannelListSkeleton = () => {
  return (
    <Skeleton.List>
      <Skeleton.Item height="34px" width="100%" />
    </Skeleton.List>
  );
};

type ChannelSectionKind = "voice" | "text";

function isTextChannel(channel: Channel) {
  return channel.type === ChannelType.SERVER_TEXT;
}

function buildChannelSections(channels: Channel[]) {
  const sections: { kind: ChannelSectionKind; channels: Channel[] }[] = [];

  channels.forEach((channel) => {
    const kind: ChannelSectionKind = isTextChannel(channel) ? "text" : "voice";
    const last = sections[sections.length - 1];
    if (last?.kind === kind) {
      last.channels.push(channel);
      return;
    }
    sections.push({ kind, channels: [channel] });
  });

  return sections;
}

function ChannelSectionDivider(props: { label: string }) {
  return (
    <div class={style.channelSectionDivider}>
      <span class={style.channelSectionLine} />
      <span class={style.channelSectionLabel}>{props.label}</span>
      <span class={style.channelSectionLine} />
    </div>
  );
}

function ChannelSectionList(props: {
  channels: Channel[];
  expanded: boolean;
  selectedChannelId?: string;
}) {
  const sections = createMemo(() => buildChannelSections(props.channels));
  const showSectionLabels = () => sections().length > 1;

  return (
    <For each={sections()}>
      {(section) => (
        <>
          <Show when={showSectionLabels()}>
            <ChannelSectionDivider
              label={t(
                section.kind === "text"
                  ? "serverDrawer.textChannels"
                  : "serverDrawer.voiceChannels"
              )}
            />
          </Show>
          <For each={section.channels}>
            {(channel) => (
              <ChannelItem
                expanded={props.expanded}
                channel={channel}
                selected={props.selectedChannelId === channel.id}
              />
            )}
          </For>
        </>
      )}
    </For>
  );
}

type RootListItem =
  | { type: "category"; channel: Channel }
  | { type: "section"; kind: ChannelSectionKind; channels: Channel[] };

const ChannelList = () => {
  const store = useStore();
  const controller = useServerDrawerController();

  const rootListItems = createMemo(() => {
    const items: RootListItem[] = [];
    let looseChannels: Channel[] = [];

    const flushLooseChannels = () => {
      if (!looseChannels.length) return;
      buildChannelSections(looseChannels).forEach((section) => {
        items.push({
          type: "section",
          kind: section.kind,
          channels: section.channels
        });
      });
      looseChannels = [];
    };

    controller?.sortedRootChannels().forEach((channel) => {
      if (!channel) return;
      if (channel.type === ChannelType.CATEGORY) {
        flushLooseChannels();
        items.push({ type: "category", channel });
        return;
      }
      looseChannels.push(channel);
    });

    flushLooseChannels();
    return items;
  });

  const showLooseSectionLabels = () => {
    const sections = rootListItems().filter((item) => item.type === "section");
    return sections.length > 1;
  };

  return (
    <div class={style.channelList}>
      <Show
        when={store.account.lastAuthenticatedAt()}
        fallback={<ChannelListSkeleton />}
      >
        <For each={rootListItems()}>
          {(item) => (
            <Switch>
              <Match when={item.type === "category"}>
                <CategoryControllerProvider
                  channel={(item as Extract<RootListItem, { type: "category" }>).channel}
                >
                  <CategoryItem
                    channel={(item as Extract<RootListItem, { type: "category" }>).channel}
                    selected={
                      controller?.params().channelId ===
                      (item as Extract<RootListItem, { type: "category" }>).channel.id
                    }
                  />
                </CategoryControllerProvider>
              </Match>
              <Match when={item.type === "section"}>
                <Show
                  when={
                    showLooseSectionLabels() ||
                    (item as Extract<RootListItem, { type: "section" }>).kind ===
                      "text"
                  }
                >
                  <ChannelSectionDivider
                    label={t(
                      (item as Extract<RootListItem, { type: "section" }>).kind ===
                        "text"
                        ? "serverDrawer.textChannels"
                        : "serverDrawer.voiceChannels"
                    )}
                  />
                </Show>
                <For
                  each={
                    (item as Extract<RootListItem, { type: "section" }>).channels
                  }
                >
                  {(channel) => (
                    <ChannelItem
                      expanded={true}
                      channel={channel}
                      selected={controller?.params().channelId === channel.id}
                    />
                  )}
                </For>
              </Match>
            </Switch>
          )}
        </For>
      </Show>
    </div>
  );
};

function CategoryItem(props: { channel: Channel; selected: boolean }) {
  const controller = useServerDrawerController();
  const categoryController = useCategoryController();

  const sortedServerChannels = () =>
    categoryController!.sortedCategoryChannels();

  const isPrivateCategory = () =>
    controller?.privateChannelIds().includes(props.channel.id);

  const expanded = createMemo(
    () => controller?.expanded(props.channel) ?? false
  );

  return (
    <Show when={!isPrivateCategory() || sortedServerChannels().length}>
      <div class={style.categoryContainer}>
        <div
          class={style.categoryItemContainer}
          onClick={() => controller?.toggleExpanded(props.channel)}
          classList={{ [style.hide!]: !expanded() }}
        >
          <Icon
            size={14}
            name="keyboard_arrow_down"
            class={cn(expanded() && style.expanded, style.expandIcon)}
          />

          <div class={style.categoryDivider}>
            <span class={style.channelSectionLine} />
            <span class={style.categoryDividerLabel}>{props.channel.name}</span>
            <span class={style.channelSectionLine} />
          </div>
          <Show when={isPrivateCategory()}>
            <Icon name="lock" size={14} style={{ opacity: 0.3 }} />
          </Show>

          <div class={style.categoryButtons}>
            <Show when={controller!.hasModeratorPermission()}>
              <Tooltip tooltip={t("channelDrawer.addChannel")}>
                <Button
                  class={style.addChannelButton}
                  padding={4}
                  margin={0}
                  iconName="add"
                  iconSize={16}
                  onClick={(e) =>
                    controller!.onAddChannelClick(e, props.channel.id)
                  }
                />
              </Tooltip>
            </Show>
          </div>
        </div>

        <Show when={sortedServerChannels().length}>
          <div class={style.categoryChannelList}>
            <ChannelSectionList
              channels={sortedServerChannels()}
              expanded={expanded()}
              selectedChannelId={controller?.params().channelId}
            />
          </div>
        </Show>
      </div>
    </Show>
  );
}

function ChannelItem(props: {
  channel: Channel;
  selected: boolean;
  expanded: boolean;
}) {
  const controller = useServerDrawerController();
  const { voiceUsers } = useStore();
  const [hovered, setHovered] = createSignal(false);

  const onMouseEnter = () => {
    setHovered(true);
    messagesPreloader.preload(props.channel.id);
  };

  const hasNotifications = () => props.channel.hasNotifications();

  const isPrivateChannel = () =>
    controller?.privateChannelIds().includes(props.channel.id);

  const onChannelDblClick = (event: MouseEvent) => {
    event.preventDefault();
    if (voiceUsers.currentUser()?.channelId === props.channel.id) return;
    props.channel.joinCall();
  };

  return (
    <Show when={props.expanded || props.selected || hasNotifications()}>
      <Item.Root
        onContextMenu={(e) =>
          controller?.onChannelContextMenu(e, props.channel)
        }
        href={RouterEndpoints.SERVER_MESSAGES(
          props.channel.serverId!,
          props.channel.id
        )}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => setHovered(false)}
        selected={props.selected}
        alert={!!hasNotifications()}
        onClick={() => emitDrawerGoToMain()}
        onDblClick={onChannelDblClick}
        class={style.channelItem}
      >
        <ChannelIcon
          icon={props.channel.icon}
          type={props.channel.type}
          hovered={hovered()}
        />
        <Item.Label>{props.channel.name}</Item.Label>
        <Show when={isPrivateChannel()}>
          <Icon
            name="lock"
            size={14}
            style={{ opacity: 0.3, "margin-right": "5px" }}
          />
        </Show>
        <Show when={props.channel.mentionCount()}>
          <div class={style.mentionCount}>{props.channel.mentionCount()}</div>
        </Show>
      </Item.Root>
      <ChannelItemVoiceUsers channelId={props.channel.id} />
    </Show>
  );
}
const ChannelVoiceUsersContainer = styled(FlexColumn)`
  gap: 2px;
  padding: 2px 4px 4px 22px;
  margin-bottom: 4px;
`;

const VoiceUserRow = styled("div")`
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 4px 6px;
  overflow: visible;
  border-radius: 4px;
  gap: 8px;
  cursor: pointer;
  &:hover {
    background-color: rgba(255, 255, 255, 0.06);
  }
`;

const VoiceUserName = styled("span")`
  overflow: hidden;
  flex: 1;
  min-width: 0;
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const LiveBadge = styled("span")`
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 3px;
  background-color: #ed4245;
  color: white;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
`;

function ChannelItemVoiceUsers(props: { channelId: string }) {
  const { voiceUsers } = useStore();
  const params = useParams<{ serverId: string }>();

  const voiceUserIds = () =>
    voiceUsers.getVoiceUsersByChannelId(props.channelId).map((user) => user.userId);

  return (
    <Show when={voiceUserIds().length}>
      <ChannelVoiceUsersContainer>
        <For each={voiceUserIds()}>
          {(userId) => (
            <ChannelVoiceUserRow
              voiceUser={voiceUsers.getVoiceUser(props.channelId, userId)!}
              serverId={params.serverId}
            />
          )}
        </For>
      </ChannelVoiceUsersContainer>
    </Show>
  );
}

function ChannelVoiceUserRow(props: {
  voiceUser: VoiceUser;
  serverId: string;
}) {
  const { voiceUsers } = useStore();
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
  } | null>(null);

  return (
    <>
      <Show when={contextMenu()}>
        <MemberContextMenu
          position={contextMenu()!}
          serverId={props.serverId}
          userId={props.voiceUser.userId}
          onClose={() => setContextMenu(null)}
        />
      </Show>
      <VoiceUserRow
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <Avatar
          user={props.voiceUser.user()}
          size={20}
          voiceIndicator
          animate={props.voiceUser.voiceActivity}
        />
        <VoiceUserName>{props.voiceUser.user()?.username}</VoiceUserName>
        <Show when={voiceUsers.videoEnabled(props.voiceUser.userId)}>
          <LiveBadge>LIVE</LiveBadge>
        </Show>
        <Show when={!voiceUsers.micEnabled(props.voiceUser.userId)}>
          <Icon name="mic_off" size={14} color="rgba(255,255,255,0.45)" />
        </Show>
      </VoiceUserRow>
    </>
  );
}

function JoinedThisSessionNotificationNotice() {
  const params = useParams<{ serverId: string }>();
  const store = useStore();
  const server = () => store.servers.get(params.serverId);

  const dismiss = () => {
    server()?.update({ joinedThisSession: false });
  };

  const handleSetToMentionsOnly = () => {
    dismiss();
    store.account.updateUserNotificationSettings({
      notificationPingMode: ServerNotificationPingMode.MENTIONS_ONLY,
      serverId: params.serverId
    });
  };

  return (
    <div class={style.joinedThisSessionNotice}>
      <Button
        iconName="close"
        iconSize={14}
        class={style.closeIcon}
        onclick={dismiss}
      />
      <Icon name="notifications" size={30} />
      <div class={style.details}>
        <div class={style.text}>
          {t("serverDrawer.joinedThisSessionNotice")}
        </div>
        <Button
          label={t("serverDrawer.joinedThisSessionNoticeSetToMentionsOnly")}
          iconName="alternate_email"
          iconSize={16}
          onClick={handleSetToMentionsOnly}
        />
      </div>
    </div>
  );
}

export default ServerDrawer;
