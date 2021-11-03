#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import log from 'loglevel';

import * as anchor from '@project-serum/anchor';
import {
  Commitment,
  Connection as RPCConnection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MintInfo,
  Token,
} from "@solana/spl-token";
import { sha256 } from "js-sha256";
import BN from 'bn.js';
import * as bs58 from "bs58";

import {
  Connection,
} from "./contexts";
import {
  ClaimantInfo,
  buildGumdrop,
  parseClaimants,
  validateTransferClaims,
  validateCandyClaims,
  validateEditionClaims,
} from "./utils/claimant";
import {
  setupSes,
  setupManual,
  setupWalletListUpload,
} from "./utils/communication";
import {
  CANDY_MACHINE_ID,
  GUMDROP_TEMPORAL_SIGNER,
  GUMDROP_DISTRIBUTOR_ID,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./utils/ids";
import {
  MerkleTree,
} from "./utils/merkleTree";

program.version('0.0.1');

log.setLevel(log.levels.INFO);

programCommand('create')
  .option(
    '--claim-integration <method>',
    'Backend for claims. Either `transfer` for token-transfers through approve-delegate, `candy` for minting through a candy-machine, or `edition` for minting through a master edition'
  )
  .option(
    '--transfer-mint <mint>',
    'transfer: public key of mint'
  )
  .option(
    '--candy-config <config>',
    'candy: public key of the candy machine config'
  )
  .option(
    '--candy-uuid <uuid>',
    'candy: uuid used to construct the candy machine'
  )
  .option(
    '--edition-mint <mint>',
    'edition: mint of the master edition'
  )
  .option(
    '--distribution-method <method>',
    // TODO: more explanation
    'Off-chain distribution of claims. Either `aws`, `manual`, or `wallets`'
  )
  .option(
    '--aws-otp-auth <auth>',
    'Off-chain OTP from claim. Either `default` for AWS OTP endpoint (email) or `none` to skip OTP'
  )
  .option(
    '--aws-ses-access-key-id <string>',
    'Access Key Id'
  )
  .option(
    '--aws-ses-secret-access-key <string>',
    'Secret Access Key'
  )
  .option(
    '--manual-otp-auth <auth>',
    'Off-chain OTP from claim. Either `default` for AWS OTP endpoint (email) or `none` to skip OTP'
  )
  .option(
    '--distribution-list <path>',
    'Off-chain OTP from claim. Either `default` for AWS OTP endpoint (email) or `none` to skip OTP'
  )
  .option(
    '--resend-only',
    'Distribute list with off-chain method only. Assumes a validator and urls already exist'
  )
  .action(async (options, cmd) => {
    log.info(`Parsed options:`, options);

    const wallet = loadWalletKey(options.keypair);
    const connection = new anchor.web3.Connection(
      //@ts-ignore
      options.rpcUrl || anchor.web3.clusterApiUrl(options.env),
    );

    const getTemporalSigner = (auth) => {
      switch (auth){
        case "default" : return GUMDROP_TEMPORAL_SIGNER;
        case "none"    : return PublicKey.default;
        default        : throw new Error(`Unknown OTP authorization type ${auth}`)
      }
    };

    let temporalSigner, sender;
    switch (options.distributionMethod) {
      case "wallets": {
        sender = setupWalletListUpload({}, "");
        temporalSigner = GUMDROP_DISTRIBUTOR_ID;
        break;
      }
      case "manual": {
        sender = setupManual({}, "");
        temporalSigner = getTemporalSigner(options.manualOtpAuth);
        break;
      }
      case "aws": {
        sender = setupSes(
          {
            accessKeyId: options.awsSesAccessKeyId,
            secretAccessKey: options.awsSesSecretAccessKey,
          },
          "santa@aws.metaplex.com",
        );
        temporalSigner = getTemporalSigner(options.awsOtpAuth);
        break;
      }
      default:
        throw new Error(
          "Distribution method must either be 'aws', 'manual', or 'wallets'.",
        );
    }
    console.log(`temporal signer: ${temporalSigner.toBase58()}`);


    let claimantsStr;
    try {
      claimantsStr = fs.readFileSync(options.distributionList).toString();
    } catch (err) {
      throw new Error(`Could not read distribution list ${err}`);
    }

    const claimants = parseClaimants(claimantsStr);
    if (claimants.length === 0) {
      throw new Error(`No claimants provided`);
    }

    let claimInfo;
    switch (options.claimIntegration) {
      case "transfer": {
        claimInfo = await validateTransferClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.transferMint,
        );
        break;
      }
      case "candy": {
        claimInfo = await validateCandyClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.candyConfig,
          options.candyUuid,
        );
        break;
      }
      case "edition": {
        claimInfo = await validateEditionClaims(
          connection,
          wallet.publicKey,
          claimants,
          options.editionMint,
        );
        break;
      }
      default:
        throw new Error(
          "Claim integration must either be 'transfer', 'candy', or 'edition'.",
        );
    }

    if (options.resendOnly) {
      if (claimants.some(c => typeof c.url !== "string")) {
        throw new Error("Specified resend only but not all claimants have a 'url'");
      }
      for (const c of claimants) {
        await sender(c, claimInfo.info);
      }
    }

    claimants.forEach(c => {
      c.pin = new BN(randomBytes());
      c.seed = options.claimIntegration === "transfer" ? claimInfo.mint.key
             : options.claimIntegration === "candy"    ? claimInfo.config
             : /* === edition */            claimInfo.masterMint.key;
    });



    const base = Keypair.generate();
    console.log(`base ${base.publicKey.toBase58()}`);

    const instructions = await buildGumdrop(
      connection,
      wallet.publicKey,
      options.distributionMethod !== "wallets",
      options.claimIntegration,
      options.host,
      base.publicKey,
      temporalSigner,
      claimants,
      claimInfo
    );

    const createResult = await sendTransactionWithRetry(
      connection,
      wallet,
      instructions,
      [base]
    );

    console.log(createResult);
    if (typeof createResult === "string") {
      throw new Error(createResult);
    } else {
      console.log(
        'Distributor creation succeeded',
        Connection.explorerLinkFor(createResult.txid, connection))
    }

    console.log("Distributing claim URLs");
    for (const c of claimants) {
      await sender(c, claimInfo.info);
    }
  });

function programCommand(name: string) {
  return program
    .command(name)
    .option(
      '-e, --env <string>',
      'Solana cluster env name',
      'devnet', //mainnet-beta, testnet, devnet
    )
    .option(
      '-k, --keypair <path>',
      `Solana wallet location`,
      '--keypair not provided',
    )
    .option(
      '-r, --rpc-url <string>',
      'Custom rpc url',
    )
    .option(
      '--host <string>',
      'Website to claim gumdrop',
    )
    .option('-l, --log-level <string>', 'log level', setLogLevel)
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value, prev) {
  if (value === undefined || value === null) {
    return;
  }
  log.info('setting the log value to: ' + value);
  log.setLevel(value);
}

function loadWalletKey(keypair) : Keypair {
  if (!keypair || keypair == '') {
    throw new Error('Keypair is required!');
  }
  const loaded = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypair).toString())),
  );
  log.info(`wallet public key: ${loaded.publicKey}`);
  return loaded;
}

// NB: assumes no overflow
function randomBytes() : Uint8Array {
  // TODO: some predictable seed? sha256?
  const buf = new Uint8Array(4);
  window.crypto.getRandomValues(buf);
  return buf;
}

async function sendTransactionWithRetry(
  connection: RPCConnection,
  wallet: Keypair,
  instructions: Array<TransactionInstruction>,
  signers: Array<Keypair>,
  commitment: Commitment = "singleGossip",
) : Promise<string| { txid: string; slot: number }> {

  let transaction = new Transaction();
  instructions.forEach((instruction) => transaction.add(instruction));
  transaction.recentBlockhash = (
    (await connection.getRecentBlockhash(commitment))
  ).blockhash;

  transaction.setSigners(
    // fee payed by the wallet owner
    wallet.publicKey,
    ...signers.map((s) => s.publicKey)
  );

  if (signers.length > 0) {
    transaction.partialSign(...signers);
  }
  transaction.partialSign(wallet);

  return Connection.sendSignedTransaction({
    connection,
    signedTransaction: transaction,
  });
};


program.parse(process.argv);