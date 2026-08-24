import { APP_NAME } from "@/common/appBrand";
import Input from "@/components/ui/input/Input";
import { registerRequest } from "../chat-api/services/UserService";
import Button from "@/components/ui/Button";
import {
  getStorageString,
  setStorageString,
  StorageKeys
} from "../common/localStorage";
import { A, useNavigate, useLocation } from "solid-navigator";
import { createSignal, onMount, Show, For } from "solid-js";
import env from "../common/env";
import PageHeader from "../components/PageHeader";
import { css, styled } from "solid-styled-components";
import { FlexColumn } from "@/components/ui/Flexbox";
import { useTransContext } from "@nerimity/solid-i18lite";
import { Turnstile, TurnstileRef } from "@nerimity/solid-turnstile";
import Text from "@/components/ui/Text";
import PageFooter from "@/components/PageFooter";
import Icon from "@/components/ui/icon/Icon";

import { MetaTitle } from "@/common/MetaTitle";

const RegisterPageContainer = styled("div")`
  display: flex;
  flex-direction: column;
  width: 100%;
  flex: 1;
`;

const Content = styled(FlexColumn)`
  height: 100%;
  border-radius: 18px;
  margin: 12px;
  margin-top: 0;
  margin-bottom: 12px;
  overflow: auto;
  flex: 1;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--pane-color);
`;

const Container = styled(FlexColumn)`
  width: 340px;
  margin: auto;
  padding: 24px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
`;

const TitleContainer = styled("div")`
  color: var(--primary-color);
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 10px;
`;

const linkStyle = css`
  margin-top: 20px;
  display: block;
  text-align: center;
`;

const NoticesContainer = styled(FlexColumn)`
  background-color: var(--pane-color);
  border: solid 1px rgba(255, 255, 255, 0.1);
  padding: 10px;
  border-radius: 6px;
`;

export default function RegisterPage() {
  const [t] = useTransContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [requestSent, setRequestSent] = createSignal(false);
  const [error, setError] = createSignal({ message: "", path: "" });
  const [email, setEmail] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  let verifyToken = "";
  let turnstileRef: TurnstileRef | undefined;
  let emailInput: HTMLInputElement | undefined;
  let usernameInput: HTMLInputElement | undefined;
  let passwordInput: HTMLInputElement | undefined;
  let confirmPasswordInput: HTMLInputElement | undefined;

  onMount(() => {
    if (getStorageString(StorageKeys.USER_TOKEN, null)) {
      navigate("/app", { replace: true });
    }
  });

  const fieldValue = (
    input: HTMLInputElement | undefined,
    fallback: string
  ) => (input?.value ?? fallback).trim();

  const registerClicked = async (event?: SubmitEvent | MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    const redirectTo = location.query.redirect || "/app/explore/themes";
    if (requestSent()) return;

    const emailValue = fieldValue(emailInput, email());
    const usernameValue = fieldValue(usernameInput, username());
    const passwordValue = fieldValue(passwordInput, password());
    const confirmValue = fieldValue(confirmPasswordInput, confirmPassword());

    setEmail(emailValue);
    setUsername(usernameValue);
    setPassword(passwordValue);
    setConfirmPassword(confirmValue);
    setError({ message: "", path: "" });

    if (!emailValue || !usernameValue || !passwordValue) {
      setError({
        message: t("registerPage.fillAllFields"),
        path: "other"
      });
      return;
    }

    if (passwordValue !== confirmValue) {
      setError({
        message: t("registerPage.passwordsDoNotMatch"),
        path: "confirmPassword"
      });
      return;
    }

    if (passwordValue.length > 72) {
      setError({
        message: t("registerPage.passwordTooLong"),
        path: "password"
      });
      return;
    }

    setRequestSent(true);
    try {
      const response = await registerRequest(
        emailValue,
        usernameValue,
        passwordValue,
        env.DEV_MODE || !env.TURNSTILE_SITEKEY
          ? verifyToken || "dev"
          : verifyToken
      );
      setStorageString(StorageKeys.USER_TOKEN, response.token);
      setStorageString(StorageKeys.FIRST_TIME, "true");
      navigate(redirectTo);
    } catch (err: any) {
      setError({
        message: err?.message || t("registerPage.registerFailed"),
        path: err?.path || "other"
      });
      turnstileRef?.reset();
    } finally {
      setRequestSent(false);
    }
  };

  const notices = [
    t("registerPage.notices.toxic"),
    t("registerPage.notices.nsfw"),
    t("registerPage.notices.age")
  ];

  return (
    <RegisterPageContainer class="register-page-container">
      <MetaTitle>{t("registerPage.header")}</MetaTitle>
      <PageHeader />
      <Content>
        <Container>
          <form
            style={{ display: "flex", "flex-direction": "column" }}
            action="#"
            novalidate
            onSubmit={registerClicked}
          >
            <TitleContainer>
              {t("registerPage.title", { appName: APP_NAME })}
            </TitleContainer>
            <NoticesContainer gap={5}>
              <span style={{ "margin-bottom": "6px" }}>
                <Icon
                  name="info"
                  color="var(--warn-color)"
                  style={{ "vertical-align": "middle", "margin-top": "-2px" }}
                  size={18}
                />{" "}
                <Text
                  style={{ "font-weight": "bold" }}
                  color="var(--warn-color)"
                >
                  {t("registerPage.notices.title")}
                </Text>
              </span>

              <For each={notices}>
                {(notice) => (
                  <Text
                    color="rgba(255, 255, 255, 0.8)"
                    style={{ display: "flex", gap: "5px" }}
                    size={14}
                  >
                    <div style={{ "margin-top": "-4px", "font-size": "20px" }}>
                      •
                    </div>{" "}
                    {notice}
                  </Text>
                )}
              </For>
            </NoticesContainer>
            <Input
              margin={[10, 0, 10, 0]}
              label={t("registerPage.email")}
              type="email"
              errorName="email"
              error={error()}
              ref={(el) => (emailInput = el as HTMLInputElement)}
              onText={setEmail}
            />
            <Input
              margin={[10, 0, 10, 0]}
              label={t("registerPage.username")}
              errorName="username"
              error={error()}
              ref={(el) => (usernameInput = el as HTMLInputElement)}
              onText={setUsername}
            />
            <Input
              margin={[10, 0, 10, 0]}
              label={t("registerPage.password")}
              type="password"
              errorName="password"
              error={error()}
              ref={(el) => (passwordInput = el as HTMLInputElement)}
              onText={setPassword}
            />
            <Input
              margin={[10, 0, 10, 0]}
              label={t("registerPage.confirmPassword")}
              type="password"
              errorName="confirmPassword"
              error={error()}
              ref={(el) => (confirmPasswordInput = el as HTMLInputElement)}
              onText={setConfirmPassword}
            />
            <Show when={!env.DEV_MODE && env.TURNSTILE_SITEKEY}>
              <Turnstile
                ref={turnstileRef}
                sitekey={env.TURNSTILE_SITEKEY}
                onVerify={(token) => (verifyToken = token)}
                autoResetOnExpire={true}
              />
            </Show>
            <Show when={error().message}>
              <Text size={16} color="var(--alert-color)">
                {error().message}
              </Text>
            </Show>
            <Text style={{ "margin-top": "10px" }} size={12} opacity={0.8}>
              {t("registerPage.agreement")}
            </Text>
            <Button
              primary
              style={{ flex: 1 }}
              margin={[10, 0, 0, 0]}
              iconName="login"
              label={
                requestSent()
                  ? t("registerPage.registering")
                  : t("registerPage.registerButton")
              }
            />
          </form>
          <A class={linkStyle} href="/login">
            {t("registerPage.loginInstead")}
          </A>
        </Container>
      </Content>
      <PageFooter />
    </RegisterPageContainer>
  );
}
