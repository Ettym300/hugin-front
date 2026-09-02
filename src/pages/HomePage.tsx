import style from "./HomePage.module.css";
import Button from "@/components/ui/Button";
import PageHeader from "../components/PageHeader";
import Text from "@/components/ui/Text";
import { useTransContext } from "@nerimity/solid-i18lite";
import { MetaTitle } from "@/common/MetaTitle";

export default function HomePage() {
  const [t] = useTransContext();

  return (
    <div class={style.homePageContainer}>
      <MetaTitle>Rugin</MetaTitle>
      <PageHeader />
      <div class={style.content}>
        <div class={style.authPanel}>
          <Text class={style.brand} size={42} bold>
            Rugin
          </Text>
          <Text size={16} opacity={0.7} class={style.subtitle}>
            Entre ou crie sua conta
          </Text>
          <div class={style.buttonsContainer}>
            <Button
              href="/login"
              class={style.primaryButton}
              iconName="login"
              label={t("header.loginButton")!}
              color="white"
            />
            <Button
              href="/register"
              class={style.secondaryButton}
              iconName="person_add"
              label={t("header.joinNowButton")!}
              color="white"
            />
          </div>
          <Text size={13} opacity={0.5} class={style.supportNote}>
            Esse aplicativo foi desenvolvido por apenas 1 dev, muito café e
            falta de sono — considere apoiar o projeto para ele continuar
            vivo. 💜
          </Text>
        </div>
      </div>
    </div>
  );
}
