import { css, styled } from "solid-styled-components";
import { CustomLink } from "./ui/CustomLink";
import { FlexRow } from "./ui/Flexbox";
import DropDown, { DropDownItem } from "./ui/drop-down/DropDown";
import {
  getCurrentLanguage,
  getLanguage,
  languages,
  setCurrentLanguage
} from "@/locales/languages";
import { useTransContext } from "@nerimity/solid-i18lite";
import { emojiUnicodeToShortcode, unicodeToTwemojiUrl } from "@/emoji";
import { Emoji } from "./markup/Emoji";
import { JSXElement } from "solid-js";

const FooterContainer = styled(FlexRow)`
  gap: 10px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-top: solid 1px rgba(255, 255, 255, 0.2);
  padding: 18px;
  flex-wrap: wrap;

  @media (max-width: 318px) {
    .footer-links {
      display: flex;
      flex-direction: column;
      text-align: center;
    }
  }
`;

export default function PageFooter() {
  return (
    <FooterContainer>
      <FlexRow gap={10} class="footer-links">
        <CustomLink decoration href="/privacy">
          Privacy Policy
        </CustomLink>
        <CustomLink decoration href="/terms-and-conditions">
          Terms And Conditions
        </CustomLink>
      </FlexRow>
      <LanguageDropdown />
    </FooterContainer>
  );
}

const LanguageDropdown = () => {
  const [, actions] = useTransContext();

  const items: DropDownItem[] = Object.keys(languages).map((key) => {
    const lang = languages[key as keyof typeof languages]!;
    return {
      id: key.replace("-", "_"),
      get label(): JSXElement {
        return (
          <>
            <Emoji
              class={css`
                height: 22px;
                width: 22px;
                align-self: flex-start;
                margin-right: 6px;
              `}
              name={emojiUnicodeToShortcode(lang.emoji)}
              url={unicodeToTwemojiUrl(lang.emoji)}
            />
            <span>{lang.nativeName ?? lang.name}</span>
          </>
        );
      }
    };
  });

  const currentLanguage = () => getCurrentLanguage() || "en-gb";

  const onChange = async (item: DropDownItem) => {
    const id = item.id;
    if (id !== "en_gb") {
      const language = await getLanguage(id);
      if (language) actions.addResources(id, "translation", language);
    }

    actions.changeLanguage(id);
    setCurrentLanguage(id);
  };

  return (
    <div class={"languageDropdown"}>
      <DropDown
        items={items}
        selectedId={currentLanguage()}
        onChange={onChange}
      />
    </div>
  );
};
