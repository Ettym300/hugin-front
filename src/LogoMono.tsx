import { appLogoUrl } from "@/common/worldEvents";
import { APP_NAME } from "@/common/appBrand";

export const LogoMono = () => {
  return (
    <img
      src={appLogoUrl()}
      alt={APP_NAME}
      draggable={false}
      style={{
        width: "100%",
        height: "100%",
        "object-fit": "contain",
        display: "block"
      }}
    />
  );
};
