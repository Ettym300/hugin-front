import { styled } from "solid-styled-components";
import ItemContainer from "./ui/LegacyItem";
import { FlexRow } from "./ui/Flexbox";
import Icon from "./ui/icon/Icon";
import { t } from "@nerimity/i18lite";
import Text from "./ui/Text";
import { useCustomPortal } from "./ui/custom-portal/CustomPortal";
import BecomeSupporterModal from "./BecomeSupporterModal";
import useAccount from "@/chat-api/store/useAccount";
import { formatTimestamp } from "@/common/date";
import { Show } from "solid-js";
const SettingItemContainer = styled(ItemContainer)<{ nested?: boolean }>`
  height: 32px;
  gap: 5px;
  padding-left: ${(props) => (props.nested ? "25px" : "10px")};
  margin-left: 3px;
  margin-right: 3px;
  margin-bottom: 2px;
  :first {
    background-color: red;
  }

  .label {
    opacity: ${(props) => (props.selected ? 1 : 0.6)};
    font-size: 14px;
    transition: 0.2s;
    color: white;
  }

  &:hover .label {
    opacity: 1;
  }
`;
export function SupportBlock() {
  const { createPortal } = useCustomPortal();
  const account = useAccount();

  const expiresAt = () => account.user()?.supporterExpiresAt;
  const isActive = () =>
    !!expiresAt() && new Date(expiresAt()!).getTime() > Date.now();

  const onClick = () => {
    createPortal?.((close) => <BecomeSupporterModal close={close} />);
  };

  return (
    <SettingItemContainer
      onClick={onClick}
      style={{
        background: isActive() ? "var(--primary-color)" : "var(--alert-color)",
        "border-radius": "6px",
        height: "initial",
        padding: "6px",
        "align-items": "start",
        "flex-direction": "column",
        cursor: "pointer"
      }}
    >
      <FlexRow gap={4}>
        <Icon
          style={{ "align-self": "start", "margin-top": "3px" }}
          name="favorite"
          size={18}
        />
        <div>
          <Show
            when={isActive()}
            fallback={
              <>
                <Text style={{ "font-weight": "bold" }}>
                  {t("supportBlock.support")}
                </Text>
                <div>
                  <Text size={12}>{t("supportBlock.supportDescription")}</Text>
                </div>
              </>
            }
          >
            <Text style={{ "font-weight": "bold" }}>
              Você é Apoiador(a)! 💜
            </Text>
            <div>
              <Text size={12}>
                Ativo até {formatTimestamp(expiresAt()!)}. Clique para
                renovar.
              </Text>
            </div>
          </Show>
        </div>
      </FlexRow>
    </SettingItemContainer>
  );
}
