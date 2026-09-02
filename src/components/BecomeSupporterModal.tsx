import { createSignal, Show } from "solid-js";
import { styled } from "solid-styled-components";
import Button from "./ui/Button";
import { FlexRow } from "./ui/Flexbox";
import Input from "./ui/input/Input";
import LegacyModal from "./ui/legacy-modal/LegacyModal";
import Text from "./ui/Text";
import { Notice } from "./ui/Notice/Notice";
import { createSupporterCheckout } from "@/chat-api/services/UserService";

const Container = styled("div")`
  min-width: 280px;
  margin-bottom: 10px;
  padding-left: 8px;
  padding-right: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

interface Props {
  close: () => void;
}

export default function BecomeSupporterModal(props: Props) {
  const [name, setName] = createSignal("");
  const [cpfCnpj, setCpfCnpj] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);

  const onContinueClick = () => {
    if (sending()) return;
    if (!name().trim() || !cpfCnpj().trim()) {
      return setError("Preencha nome e CPF/CNPJ.");
    }
    setSending(true);
    setError(null);
    createSupporterCheckout(name().trim(), cpfCnpj().trim())
      .then((res) => {
        window.open(res.invoiceUrl, "_blank");
        props.close();
      })
      .catch((err) => setError(err.message))
      .finally(() => setSending(false));
  };

  const ActionButtons = (
    <FlexRow
      style={{
        "justify-content": "flex-end",
        flex: 1,
        margin: "5px",
        gap: "4px"
      }}
    >
      <Button
        onClick={onContinueClick}
        margin={0}
        color="var(--primary-color)"
        label={sending() ? "Gerando cobrança..." : "Continuar para pagamento"}
        primary
      />
    </FlexRow>
  );

  return (
    <LegacyModal
      close={props.close}
      title="Virar Apoiador(a)"
      actionButtons={ActionButtons}
      ignoreBackgroundClick
    >
      <Container>
        <Notice
          type="info"
          description="Você será redirecionado para uma página segura do Asaas, onde pode pagar por Pix, cartão ou boleto."
        />
        <Input label="Nome completo" value={name()} onText={setName} />
        <Input
          label="CPF ou CNPJ"
          value={cpfCnpj()}
          onText={setCpfCnpj}
          placeholder="Só números"
        />
        <Show when={error()}>
          <Text color="var(--alert-color)" size={12}>
            {error()}
          </Text>
        </Show>
      </Container>
    </LegacyModal>
  );
}
